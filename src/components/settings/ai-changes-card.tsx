import type { ChangeView } from '@/lib/ai-settings/actions'

import { formatWhen } from './source-badge'

const ACTION_TEXT: Record<string, string> = {
  save: 'changed',
  reset: 'reset',
  'connection-add': 'added connection',
  'connection-edit': 'edited connection',
  'connection-remove': 'removed connection',
}

/** `connection:chat` → `Chat connection`; a setting keeps its variable name. */
function keyText(key: string): string {
  return key.startsWith('connection:')
    ? `${key.slice('connection:'.length)} connection`
    : key
}

/**
 * The latest changes to AI settings (spec 0040 FR5): who changed what, from
 * what to what. API keys appear only as their `••••1a2b` hint.
 */
export function AiChangesCard({ changes }: { changes: ChangeView[] }) {
  if (changes.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing has been changed here yet.
      </p>
    )
  }
  return (
    <ol className="divide-y rounded-lg border text-sm">
      {changes.map((c, i) => (
        <li key={`${c.at}-${i}`} className="space-y-0.5 px-4 py-2.5">
          <p>
            <span className="font-medium">{c.by ?? 'A deleted user'}</span>{' '}
            {ACTION_TEXT[c.action] ?? c.action}{' '}
            <span className="font-mono text-xs">{keyText(c.key)}</span>
            <span className="text-muted-foreground">
              {' · '}
              {formatWhen(c.at)} UTC
            </span>
          </p>
          {(c.oldValue !== null || c.newValue !== null) && (
            <p className="text-muted-foreground font-mono text-xs break-all">
              {c.oldValue ?? '—'} → {c.newValue ?? '—'}
            </p>
          )}
        </li>
      ))}
    </ol>
  )
}
