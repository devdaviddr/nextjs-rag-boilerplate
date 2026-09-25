'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Pencil, Plug, Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  type ConnectionView,
  deleteConnection,
  saveConnection,
  testConnection,
} from '@/lib/ai-settings/actions'
import { PRESETS, type PresetId, presetById } from '@/lib/ai-settings/presets'
import { ROLE_LABELS } from './ai-role-labels'

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string }

function TestLine({ state }: { state: TestState }) {
  if (state.kind === 'idle') return null
  if (state.kind === 'running') {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
        <Loader2 className="size-3.5 animate-spin" /> Testing…
      </p>
    )
  }
  return (
    <p
      role="status"
      className={
        state.kind === 'ok'
          ? 'text-sm text-emerald-700 dark:text-emerald-400'
          : 'text-destructive text-sm'
      }
    >
      {state.text}
    </p>
  )
}

function describeTest(
  result: Awaited<ReturnType<typeof testConnection>>,
): TestState {
  if (!result.ok) return { kind: 'error', text: result.error }
  const { latencyMs, models } = result.data
  return {
    kind: 'ok',
    text: `Connected in ${latencyMs} ms${models.length ? ` · ${models.length} model${models.length === 1 ? '' : 's'} listed` : ''}`,
  }
}

interface FormState {
  id?: string
  preset: PresetId
  name: string
  baseUrl: string
  apiKey: string
  hasSavedKey: boolean
}

function emptyForm(): FormState {
  const preset = presetById('openrouter')
  return {
    preset: preset.id,
    name: preset.label,
    baseUrl: preset.baseUrl,
    apiKey: '',
    hasSavedKey: false,
  }
}

function ConnectionDialog({
  initial,
  open,
  onOpenChange,
}: {
  initial: FormState
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [form, setForm] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [pending, startTransition] = useTransition()
  const preset = presetById(form.preset)
  const editing = Boolean(form.id)

  const choosePreset = (id: PresetId) => {
    const next = presetById(id)
    setForm((f) => ({
      ...f,
      preset: id,
      // Only replace what the admin has not changed from the last preset.
      name:
        f.name === presetById(f.preset).label || !f.name ? next.label : f.name,
      baseUrl:
        f.baseUrl === presetById(f.preset).baseUrl || !f.baseUrl
          ? next.baseUrl
          : f.baseUrl,
    }))
    setTest({ kind: 'idle' })
  }

  const runTest = () => {
    setTest({ kind: 'running' })
    startTransition(async () => {
      setTest(
        describeTest(
          await testConnection({
            id: form.id,
            baseUrl: form.baseUrl,
            apiKey: form.apiKey,
          }),
        ),
      )
    })
  }

  const save = () => {
    setError(null)
    startTransition(async () => {
      const result = await saveConnection({
        id: form.id,
        name: form.name,
        preset: form.preset,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey || undefined,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      onOpenChange(false)
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Edit connection' : 'Add a connection'}
          </DialogTitle>
          <DialogDescription>
            Any OpenAI-compatible endpoint. The provider receives the questions
            and the passages retrieved to answer them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="conn-preset">Provider</Label>
            <Select
              value={form.preset}
              onValueChange={(v) => choosePreset(v as PresetId)}
            >
              <SelectTrigger id="conn-preset" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{preset.note}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="conn-name">Name</Label>
            <Input
              id="conn-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="conn-url">Base URL</Label>
            <Input
              id="conn-url"
              value={form.baseUrl}
              placeholder="https://…/v1"
              spellCheck={false}
              className="font-mono text-sm"
              onChange={(e) => {
                setForm({ ...form, baseUrl: e.target.value })
                setTest({ kind: 'idle' })
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="conn-key">
              API key{' '}
              {!preset.keyRequired && (
                <span className="text-muted-foreground font-normal">
                  (if the server needs one)
                </span>
              )}
            </Label>
            <Input
              id="conn-key"
              type="password"
              autoComplete="off"
              value={form.apiKey}
              placeholder={
                form.hasSavedKey ? 'Saved. Leave blank to keep it' : ''
              }
              onChange={(e) => {
                setForm({ ...form, apiKey: e.target.value })
                setTest({ kind: 'idle' })
              }}
            />
            <p className="text-muted-foreground text-xs">
              Stored encrypted, and never shown again.
            </p>
          </div>

          <TestLine state={test} />
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={runTest} disabled={pending}>
            <Plug /> Test
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            {editing ? 'Save' : 'Add connection'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Settings → AI provider (spec 0040 FR1): the endpoints the app can use.
 * The `.env` endpoint is listed first and edited in `.env`; the others are
 * added here. Which job uses which is chosen under Models.
 */
export function AiConnectionsCard({
  connections,
}: {
  connections: ConnectionView[]
}) {
  const router = useRouter()
  const [dialog, setDialog] = useState<FormState | null>(null)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const runTest = (id: string) => {
    setTests((t) => ({ ...t, [id]: { kind: 'running' } }))
    startTransition(async () => {
      const state = describeTest(await testConnection({ id }))
      setTests((t) => ({ ...t, [id]: state }))
    })
  }

  const remove = (c: ConnectionView) => {
    const using = c.usedBy.length
      ? ` ${c.usedBy.map((r) => ROLE_LABELS[r].label).join(', ')} will go back to the .env connection.`
      : ''
    if (!window.confirm(`Remove "${c.name}"?${using}`)) return
    setRemoveError(null)
    startTransition(async () => {
      const result = await deleteConnection(c.id)
      if (!result.ok) setRemoveError(result.error)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {connections.length} connection{connections.length === 1 ? '' : 's'}.
          Choose which job uses which under Models.
        </p>
        <Button size="sm" onClick={() => setDialog(emptyForm())}>
          <Plus /> Add connection
        </Button>
      </div>
      <div>
        <ul className="divide-y rounded-lg border">
          {connections.map((c) => (
            <li key={c.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {c.name}
                    <Badge variant="secondary">
                      {presetById(c.preset).label}
                    </Badge>
                    {c.builtIn && <Badge variant="outline">built in</Badge>}
                  </div>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {c.baseUrl}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {c.keyUnreadable ? (
                      <span className="text-destructive">
                        The saved key can no longer be read. Edit to enter it
                        again.
                      </span>
                    ) : c.keyHint ? (
                      <>Key {c.keyHint}</>
                    ) : (
                      'No API key'
                    )}
                    {c.usedBy.length > 0 && (
                      <>
                        {' · Used by '}
                        {c.usedBy.map((r) => ROLE_LABELS[r].label).join(', ')}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runTest(c.id)}
                    disabled={pending}
                  >
                    Test
                  </Button>
                  {!c.builtIn && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Edit ${c.name}`}
                        onClick={() =>
                          setDialog({
                            id: c.id,
                            preset: c.preset,
                            name: c.name,
                            baseUrl: c.baseUrl,
                            apiKey: '',
                            hasSavedKey: Boolean(c.keyHint),
                          })
                        }
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Remove ${c.name}`}
                        onClick={() => remove(c)}
                        disabled={pending}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {c.builtIn && (
                <p className="text-muted-foreground text-xs">
                  From <code>RAG_LLM_BASE_URL</code> and{' '}
                  <code>NVIDIA_API_KEY</code>; change it in <code>.env</code>.
                </p>
              )}
              <TestLine state={tests[c.id] ?? { kind: 'idle' }} />
            </li>
          ))}
        </ul>
        {removeError && (
          <p role="alert" className="text-destructive mt-3 text-sm">
            {removeError}
          </p>
        )}
      </div>
      {dialog && (
        <ConnectionDialog
          key={dialog.id ?? 'new'}
          initial={dialog}
          open
          onOpenChange={(open) => !open && setDialog(null)}
        />
      )}
    </div>
  )
}
