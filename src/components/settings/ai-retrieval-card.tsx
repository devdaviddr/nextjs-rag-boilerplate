'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { InfoTip } from '@/components/ui/info-tip'
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
  type FieldView,
  resetRetrievalSetting,
  saveRetrievalSetting,
} from '@/lib/ai-settings/actions'
import {
  RETRIEVAL_GROUPS,
  type RetrievalField,
  describeRange,
} from '@/lib/ai-settings/retrieval-fields'

import { SourceBadge } from './source-badge'

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string }

function Control({
  id,
  field,
  value,
  onChange,
  disabled,
}: {
  id: string
  field: RetrievalField
  value: string
  onChange: (value: string) => void
  disabled: boolean
}) {
  switch (field.kind) {
    case 'boolean':
      return (
        <Checkbox
          id={id}
          checked={value === 'true'}
          onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
          disabled={disabled}
        />
      )
    case 'enum':
      return (
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={id} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case 'text':
      return (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-full max-w-sm font-mono text-sm"
        />
      )
    default:
      return (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={value}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-32 tabular-nums"
        />
      )
  }
}

function FieldRow({
  field,
  view,
  locked,
}: {
  field: RetrievalField
  view: FieldView
  locked: boolean
}) {
  const router = useRouter()
  const id = useId()
  const [value, setValue] = useState(view.value)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [pending, startTransition] = useTransition()
  const dirty = value !== view.value

  const run = (
    action: () => Promise<{ ok: true } | { ok: false; error: string }>,
    done: string,
  ) => {
    setStatus({ kind: 'busy' })
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        setStatus({ kind: 'error', text: result.error })
        return
      }
      setStatus({ kind: 'ok', text: done })
      router.refresh()
    })
  }

  return (
    <li className="space-y-2 p-4" data-setting={field.key}>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={id} className="font-medium">
          {field.label}
        </Label>
        <InfoTip title={field.label}>
          <p>{field.help}</p>
          <p>
            Allowed: {describeRange(field)}. Variable: <code>{field.key}</code>.
          </p>
        </InfoTip>
        <SourceBadge source={view.source} saved={view.saved} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Control
          id={id}
          field={field}
          value={value}
          onChange={(v) => {
            setValue(v)
            setStatus({ kind: 'idle' })
          }}
          disabled={locked || pending}
        />
        {!locked && (
          <>
            <Button
              size="sm"
              onClick={() =>
                run(
                  () => saveRetrievalSetting(field.key, value),
                  field.newUploadsOnly
                    ? 'Saved. Applies to documents uploaded from now on.'
                    : 'Saved. Applies to the next question.',
                )
              }
              disabled={!dirty || pending}
            >
              Save
            </Button>
            {view.source === 'saved' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  run(
                    () => resetRetrievalSetting(field.key),
                    'Back to the .env value.',
                  )
                }
                disabled={pending}
              >
                <RotateCcw /> Use .env
              </Button>
            )}
          </>
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
            {status.kind === 'busy' ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Saving…
              </>
            ) : (
              status.text
            )}
          </span>
        )}
      </div>
      {field.newUploadsOnly && (
        <p className="text-muted-foreground text-xs">
          Affects documents uploaded after a change. To apply it to an existing
          document, upload it again.
        </p>
      )}
    </li>
  )
}

/**
 * Settings → Retrieval & answering (spec 0040 FR4): the switches and limits
 * behind search and answering, each saved on its own and applied to the next
 * request.
 */
export function AiRetrievalCard({
  fields,
  locked = false,
}: {
  fields: FieldView[]
  locked?: boolean
}) {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  return (
    <div className="space-y-6">
      {RETRIEVAL_GROUPS.map((group) => (
        <div key={group.id} className="space-y-2">
          <h4 className="text-muted-foreground text-sm font-medium">
            {group.title}
          </h4>
          <ul className="divide-y rounded-lg border">
            {group.fields.map((field) => {
              const view = byKey.get(field.key)
              return view ? (
                <FieldRow
                  // Remount when the saved value changes, so the form resets.
                  key={`${field.key}:${view.value}:${view.source}`}
                  field={field}
                  view={view}
                  locked={locked}
                />
              ) : null
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
