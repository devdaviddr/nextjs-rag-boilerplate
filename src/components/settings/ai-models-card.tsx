'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Cpu, Loader2, RotateCcw } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
  type RoleView,
  type Source,
  modelsFor,
  resetRole,
  saveRole,
  testRole,
} from '@/lib/ai-settings/actions'
import { ROLE_LABELS } from './ai-role-labels'

const SOURCE_TEXT: Record<Source, string> = {
  saved: 'saved here',
  env: 'from .env',
  default: 'default',
}

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string }

function RoleRow({
  role,
  connections,
}: {
  role: RoleView
  connections: ConnectionView[]
}) {
  const router = useRouter()
  const listId = useId()
  const [connectionId, setConnectionId] = useState(role.connectionId)
  const [model, setModel] = useState(role.model)
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [pending, startTransition] = useTransition()
  const labels = ROLE_LABELS[role.role]
  const editable = role.role !== 'embed'
  const dirty = connectionId !== role.connectionId || model !== role.model
  const customised = role.source === 'saved' || role.connectionId !== 'env'

  /** Fill the model picker from the connection's /models, once. */
  const loadModels = (id: string) => {
    if (models[id]) return
    startTransition(async () => {
      const result = await modelsFor(id)
      setModels((m) => ({ ...m, [id]: result.ok ? result.data : [] }))
    })
  }

  const save = () => {
    setStatus({ kind: 'busy', text: 'Saving…' })
    startTransition(async () => {
      const result = await saveRole({ role: role.role, connectionId, model })
      if (!result.ok) {
        setStatus({ kind: 'error', text: result.error })
        return
      }
      setStatus({ kind: 'ok', text: 'Saved. Applies to the next request.' })
      router.refresh()
    })
  }

  const test = () => {
    setStatus({ kind: 'busy', text: 'Testing…' })
    startTransition(async () => {
      const result = await testRole(role.role)
      setStatus(
        result.ok
          ? {
              kind: 'ok',
              text: `${result.data.detail} in ${result.data.latencyMs} ms`,
            }
          : { kind: 'error', text: result.error },
      )
    })
  }

  const reset = () => {
    setStatus({ kind: 'busy', text: 'Resetting…' })
    startTransition(async () => {
      const result = await resetRole(role.role)
      if (!result.ok) {
        setStatus({ kind: 'error', text: result.error })
        return
      }
      setStatus({ kind: 'ok', text: 'Back to the .env settings.' })
      router.refresh()
    })
  }

  const options = models[connectionId] ?? []

  return (
    <li className="space-y-3 p-4" data-role={role.role}>
      <div>
        <div className="flex items-center gap-2 font-medium">
          {labels.label}
          <Badge variant="outline" className="font-normal">
            {SOURCE_TEXT[role.source]}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">{labels.help}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <Label htmlFor={`${listId}-conn`} className="text-xs">
            Connection
          </Label>
          <Select
            value={connectionId}
            onValueChange={(v) => {
              setConnectionId(v)
              setStatus({ kind: 'idle' })
            }}
            disabled={!role.canChangeConnection}
          >
            <SelectTrigger id={`${listId}-conn`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {connections.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${listId}-model`} className="text-xs">
            Model
          </Label>
          <Input
            id={`${listId}-model`}
            value={model}
            list={`${listId}-models`}
            spellCheck={false}
            className="font-mono text-sm"
            disabled={!editable}
            onFocus={() => loadModels(connectionId)}
            onChange={(e) => {
              setModel(e.target.value)
              setStatus({ kind: 'idle' })
            }}
          />
          <datalist id={`${listId}-models`}>
            {options.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {editable && (
          <Button size="sm" onClick={save} disabled={!dirty || pending}>
            Save
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={test}
          disabled={dirty || pending}
          title={dirty ? 'Save first, then test' : undefined}
        >
          Test
        </Button>
        {editable && customised && (
          <Button size="sm" variant="ghost" onClick={reset} disabled={pending}>
            <RotateCcw /> Use .env
          </Button>
        )}
        {status.kind !== 'idle' && (
          <span
            role="status"
            className={
              status.kind === 'error'
                ? 'text-destructive text-sm'
                : status.kind === 'ok'
                  ? 'text-sm text-emerald-700 dark:text-emerald-400'
                  : 'text-muted-foreground flex items-center gap-1.5 text-sm'
            }
          >
            {status.kind === 'busy' && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {status.text}
          </span>
        )}
      </div>
    </li>
  )
}

/**
 * Settings → Models (spec 0040 FR2): which connection and model each job
 * uses. A change applies to the next request; "Use .env" removes it.
 */
export function AiModelsCard({
  roles,
  connections,
}: {
  roles: RoleView[]
  connections: ConnectionView[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-5" />
          Models
        </CardTitle>
        <CardDescription>
          The model each job uses, and where it runs. The model list comes from
          the connection; you can also type a name.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-lg border">
          {roles.map((role) => (
            <RoleRow
              // Remount when the saved values change, so the form resets.
              key={`${role.role}:${role.connectionId}:${role.model}`}
              role={role}
              connections={connections}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
