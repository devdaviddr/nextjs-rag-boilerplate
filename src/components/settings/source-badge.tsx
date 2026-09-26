import { Badge } from '@/components/ui/badge'
import type { Source } from '@/lib/ai-settings/actions'
import type { SavedMeta } from '@/lib/ai-settings'

const SOURCE_TEXT: Record<Source, string> = {
  saved: 'saved here',
  env: 'from .env',
  default: 'default',
}

/** `2026-09-26 14:05`, the same on the server and in the browser. */
export function formatWhen(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

/**
 * Where a setting's value comes from (spec 0040 FR5): the default, `.env`, or
 * saved here, with who saved it and when.
 */
export function SourceBadge({
  source,
  saved,
}: {
  source: Source
  saved: SavedMeta | null
}) {
  const detail =
    source === 'saved' && saved
      ? `Saved${saved.by ? ` by ${saved.by}` : ''}${saved.at ? ` on ${formatWhen(saved.at)} UTC` : ''}`
      : undefined
  return (
    <Badge variant="outline" className="font-normal" title={detail}>
      {SOURCE_TEXT[source]}
      {source === 'saved' && saved?.by ? ` by ${saved.by}` : ''}
    </Badge>
  )
}
