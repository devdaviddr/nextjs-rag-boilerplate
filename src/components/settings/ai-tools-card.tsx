'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
  type McpServerView,
  removeMcpServer,
  saveMcpServer,
  setMcpToolEnabled,
  testMcpServer,
} from '@/lib/ai-settings/actions'

interface FormState {
  id?: string
  name: string
  url: string
  token: string
  hasSavedToken: boolean
  internal: boolean
}

const emptyForm = (): FormState => ({
  name: '',
  url: '',
  token: '',
  hasSavedToken: false,
  internal: false,
})

function ServerDialog({
  form: initial,
  onOpenChange,
}: {
  form: FormState
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [form, setForm] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const editing = Boolean(form.id)

  const save = () => {
    setError(null)
    startTransition(async () => {
      const saved = await saveMcpServer({
        id: form.id,
        name: form.name,
        url: form.url,
        token: form.token || undefined,
        internal: form.internal,
      })
      if (!saved.ok) {
        setError(saved.error)
        return
      }
      // Saved: from here on this dialog edits it, whatever the test says.
      setForm((f) => ({
        ...f,
        id: saved.data.id,
        token: '',
        hasSavedToken: f.hasSavedToken || Boolean(f.token),
      }))
      // A new server is tested straight away, so its tools are listed.
      const tested = await testMcpServer(saved.data.id)
      if (!tested.ok) {
        setError(`Saved, but the test failed: ${tested.error}`)
        router.refresh()
        return
      }
      onOpenChange(false)
      router.refresh()
    })
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Edit tool server' : 'Add a tool server'}
          </DialogTitle>
          <DialogDescription>
            A Model Context Protocol server, reached over Streamable HTTP. Its
            tools are listed after a test, each off until you switch it on.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              Part of each tool&apos;s name, as the agent sees it.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              value={form.url}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              className="font-mono text-sm"
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-token">
              Bearer token{' '}
              <span className="text-muted-foreground font-normal">
                (if the server needs one)
              </span>
            </Label>
            <Input
              id="mcp-token"
              type="password"
              autoComplete="off"
              value={form.token}
              placeholder={
                form.hasSavedToken ? 'Saved. Leave blank to keep it' : ''
              }
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              Stored encrypted, and never shown again.
            </p>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="mcp-internal"
              checked={form.internal}
              onCheckedChange={(v) =>
                setForm({ ...form, internal: v === true })
              }
            />
            <div className="space-y-1">
              <Label htmlFor="mcp-internal">On a private network</Label>
              <p className="text-muted-foreground text-xs">
                Lets the app reach a private or local address, which it
                otherwise refuses. Only for a server you run; this is logged.
              </p>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            {editing ? 'Save and test' : 'Add and test'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Settings → Tools (spec 0048): MCP servers whose tools the agent may call.
 * Every tool is off until an admin switches it on.
 */
export function AiToolsCard({
  servers,
  locked = false,
}: {
  servers: McpServerView[]
  /** `AI_SETTINGS_LOCKED`: servers can be tested, not changed. */
  locked?: boolean
}) {
  const router = useRouter()
  const [dialog, setDialog] = useState<FormState | null>(null)
  const [status, setStatus] = useState<
    Record<string, { ok: boolean; text: string } | undefined>
  >({})
  const [pending, startTransition] = useTransition()

  const test = (s: McpServerView) =>
    startTransition(async () => {
      const result = await testMcpServer(s.id)
      setStatus((prev) => ({
        ...prev,
        [s.id]: result.ok
          ? {
              ok: true,
              text: `Connected in ${result.data.latencyMs} ms · ${result.data.tools} tool${result.data.tools === 1 ? '' : 's'} listed`,
            }
          : { ok: false, text: result.error },
      }))
      router.refresh()
    })

  const toggle = (s: McpServerView, tool: string, enabled: boolean) =>
    startTransition(async () => {
      const result = await setMcpToolEnabled(s.id, tool, enabled)
      if (!result.ok) {
        setStatus((prev) => ({
          ...prev,
          [s.id]: { ok: false, text: result.error },
        }))
      }
      router.refresh()
    })

  const remove = (s: McpServerView) => {
    if (!window.confirm(`Remove "${s.name}" and its tools?`)) return
    startTransition(async () => {
      await removeMcpServer(s.id)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          The server does not know which user is asking, so switch on only tools
          whose answers any user may see.
        </p>
        {!locked && (
          <Button size="sm" onClick={() => setDialog(emptyForm())}>
            <Plus /> Add tool server
          </Button>
        )}
      </div>

      {servers.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border p-4 text-sm">
          No tool servers. The agent uses its built-in tools only.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {servers.map((s) => (
            <li key={s.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {s.name}
                    {s.internal && (
                      <Badge variant="outline">private network</Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {s.url}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {s.hasToken
                      ? s.tokenHint
                        ? `Token ••••${s.tokenHint}`
                        : 'Token saved'
                      : 'No token'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => test(s)}
                    disabled={pending}
                  >
                    Test
                  </Button>
                  {!locked && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Edit ${s.name}`}
                        onClick={() =>
                          setDialog({
                            id: s.id,
                            name: s.name,
                            url: s.url,
                            token: '',
                            hasSavedToken: s.hasToken,
                            internal: s.internal,
                          })
                        }
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Remove ${s.name}`}
                        onClick={() => remove(s)}
                        disabled={pending}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {status[s.id] && (
                <p
                  role="status"
                  className={
                    status[s.id]!.ok
                      ? 'text-sm text-emerald-700 dark:text-emerald-400'
                      : 'text-destructive text-sm'
                  }
                >
                  {status[s.id]!.text}
                </p>
              )}

              {s.tools.length > 0 ? (
                <ul className="space-y-2">
                  {s.tools.map((t) => {
                    const id = `mcp-${s.id}-${t.name}`
                    return (
                      <li key={t.name} className="flex items-start gap-2">
                        <Checkbox
                          id={id}
                          checked={t.enabled}
                          disabled={locked || pending}
                          onCheckedChange={(v) => toggle(s, t.name, v === true)}
                        />
                        <div className="min-w-0 space-y-0.5">
                          <Label htmlFor={id} className="font-mono text-sm">
                            {t.name}
                          </Label>
                          {t.description && (
                            <p className="text-muted-foreground text-xs">
                              {t.description}
                            </p>
                          )}
                          <p className="text-muted-foreground text-xs">
                            What it returns can reach any user who asks.
                          </p>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="text-muted-foreground text-xs">
                  No tools listed yet. Test the server to list them.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {dialog && (
        <ServerDialog
          form={dialog}
          onOpenChange={(open) => !open && setDialog(null)}
        />
      )}
    </div>
  )
}
