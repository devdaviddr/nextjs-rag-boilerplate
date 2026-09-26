'use client'

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
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
  cancelReindex,
  modelsFor,
  resetRole,
  saveRole,
  testRole,
} from '@/lib/ai-settings/actions'
import type { ReindexView } from '@/lib/rag/generations'
import { InfoTip } from '@/components/ui/info-tip'
import { FIELD_HELP, ROLE_LABELS } from './ai-role-labels'
import { type ModelList, ModelPicker } from './model-picker'
import { SourceBadge } from './source-badge'

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string }

function RoleRow({
  role,
  connections,
  modelList,
  loadModels,
  locked,
}: {
  role: RoleView
  connections: ConnectionView[]
  modelList: (connectionId: string) => ModelList
  loadModels: (connectionId: string) => void
  /** `AI_SETTINGS_LOCKED`: shown and testable, never changed (FR5). */
  locked: boolean
}) {
  const router = useRouter()
  const listId = useId()
  const [connectionId, setConnectionId] = useState(role.connectionId)
  const [model, setModel] = useState(role.model)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [pending, startTransition] = useTransition()
  const labels = ROLE_LABELS[role.role]
  const editable = !locked
  const dirty = connectionId !== role.connectionId || model !== role.model
  const customised = role.source === 'saved' || role.connectionId !== 'env'

  const save = () => {
    if (!dirty) {
      setStatus({
        kind: 'ok',
        text: 'Nothing to save. Change the connection or model first.',
      })
      return
    }
    if (
      role.role === 'embed' &&
      !window.confirm(
        `Re-index every document with ${model}?\n\n` +
          'Every passage is embedded again with the new model. Search keeps using ' +
          'the current model until that finishes, then switches over in one step. ' +
          'The relevance floor was tuned for the current model, so check answers ' +
          'afterwards.',
      )
    ) {
      return
    }
    setStatus({ kind: 'busy', text: 'Saving…' })
    startTransition(async () => {
      const result = await saveRole({ role: role.role, connectionId, model })
      if (!result.ok) {
        setStatus({ kind: 'error', text: result.error })
        return
      }
      setStatus({
        kind: 'ok',
        text:
          role.role === 'embed'
            ? 'Re-indexing started.'
            : 'Saved. Applies to the next request.',
      })
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

  return (
    <li className="space-y-3 p-4" data-role={role.role}>
      <div>
        <div className="flex items-center gap-2 font-medium">
          {labels.label}
          <InfoTip title={labels.label}>
            {labels.details.map((d) => (
              <p key={d}>{d}</p>
            ))}
          </InfoTip>
          <SourceBadge source={role.source} saved={role.saved} />
        </div>
        <p className="text-muted-foreground text-sm">{labels.help}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor={`${listId}-conn`} className="text-xs">
              Connection
            </Label>
            <InfoTip title={FIELD_HELP.connection.title}>
              {FIELD_HELP.connection.details.map((d) => (
                <p key={d}>{d}</p>
              ))}
            </InfoTip>
          </div>
          <Select
            value={connectionId}
            onValueChange={(v) => {
              setConnectionId(v)
              setStatus({ kind: 'idle' })
            }}
            disabled={!role.canChangeConnection || locked}
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
          <div className="flex items-center gap-1">
            <Label htmlFor={`${listId}-model`} className="text-xs">
              Model
            </Label>
            <InfoTip title={FIELD_HELP.model.title}>
              {FIELD_HELP.model.details.map((d) => (
                <p key={d}>{d}</p>
              ))}
            </InfoTip>
          </div>
          <ModelPicker
            id={`${listId}-model`}
            value={model}
            list={modelList(connectionId)}
            onOpen={() => loadModels(connectionId)}
            disabled={!editable}
            onChange={(m) => {
              setModel(m)
              setStatus({ kind: 'idle' })
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {editable && (
          <Button size="sm" onClick={save} disabled={pending}>
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
        {editable && customised && role.role !== 'embed' && (
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

/** How often the page re-reads a running re-index's progress. */
const REINDEX_POLL_MS = 5000

/**
 * A re-index in progress (#56): how far it has got, its last error, and a
 * way to stop it. Search is on the current model until it finishes.
 */
function ReindexPanel({
  reindex,
  locked,
}: {
  reindex: ReindexView
  locked: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const building = reindex.building

  useEffect(() => {
    if (!building) return
    const timer = setInterval(() => router.refresh(), REINDEX_POLL_MS)
    return () => clearInterval(timer)
  }, [building, router])

  if (!building) return null
  const percent = building.totalChunks
    ? Math.min(
        100,
        Math.round((building.embeddedChunks / building.totalChunks) * 100),
      )
    : 0

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-muted/40 space-y-2 rounded-lg border p-4 text-sm"
    >
      <p>
        Re-indexing with <span className="font-mono">{building.model}</span> (
        {building.dimensions} dimensions):{' '}
        {building.embeddedChunks.toLocaleString('en')} of{' '}
        {building.totalChunks.toLocaleString('en')} passages.
      </p>
      <div
        className="bg-muted h-2 overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <div
          className="bg-primary h-full transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-muted-foreground">
        Search uses <span className="font-mono">{reindex.activeModel}</span>{' '}
        until this finishes, then switches over in one step.
      </p>
      {building.error && (
        <p className="text-destructive">
          Paused: {building.error}. It retries within a minute.
        </p>
      )}
      {error && <p className="text-destructive">{error}</p>}
      {!locked && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            if (!window.confirm('Stop re-indexing and discard its progress?'))
              return
            startTransition(async () => {
              const result = await cancelReindex()
              if (!result.ok) setError(result.error)
              router.refresh()
            })
          }}
        >
          Cancel re-index
        </Button>
      )}
    </div>
  )
}

/**
 * Settings → Models (spec 0040 FR2): which connection and model each job
 * uses. A change applies to the next request; "Use .env" removes it. A new
 * embedding model is a re-index (FR3).
 */
export function AiModelsCard({
  roles,
  connections,
  reindex,
  locked = false,
}: {
  roles: RoleView[]
  connections: ConnectionView[]
  reindex?: ReindexView
  locked?: boolean
}) {
  // One /models request per connection, shared by every job's picker.
  const [lists, setLists] = useState<Record<string, ModelList>>({})
  const requested = useRef(new Set<string>())
  const loadModels = useCallback((connectionId: string) => {
    if (requested.current.has(connectionId)) return
    requested.current.add(connectionId)
    setLists((l) => ({ ...l, [connectionId]: { status: 'loading' } }))
    void modelsFor(connectionId).then((result) => {
      if (!result.ok) requested.current.delete(connectionId) // retry next open
      setLists((l) => ({
        ...l,
        [connectionId]: result.ok
          ? {
              status: 'ready',
              models: result.data.models,
              details: result.data.details,
            }
          : { status: 'error', error: result.error },
      }))
    })
  }, [])
  const modelList = (connectionId: string): ModelList =>
    lists[connectionId] ?? { status: 'idle' }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-muted-foreground text-sm">
          Pick from the models a connection lists, or type any name it serves. A
          new embedding model re-indexes every document first.
        </p>
      </div>
      <div>
        <ul className="divide-y rounded-lg border">
          {roles.map((role) => (
            <RoleRow
              // Remount when the saved values change, so the form resets.
              key={`${role.role}:${role.connectionId}:${role.model}`}
              role={role}
              connections={connections}
              modelList={modelList}
              loadModels={loadModels}
              locked={locked}
            />
          ))}
        </ul>
      </div>
      {reindex && <ReindexPanel reindex={reindex} locked={locked} />}
    </div>
  )
}
