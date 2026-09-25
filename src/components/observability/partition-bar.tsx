import { cn } from '@/lib/utils'

/**
 * Parts of a whole in one bar (spec 0042 FR10), after 8starlabs' Partition
 * Bar on 21st.dev (MIT). The legend repeats every segment with its count and
 * share, so nothing depends on telling the colours apart.
 */
export function PartitionBar({
  segments,
  label,
}: {
  segments: { name: string; count: number; className: string }[]
  label: string
}) {
  const total = segments.reduce((sum, s) => sum + s.count, 0)
  if (total === 0) {
    return <p className="text-muted-foreground text-sm">Nothing yet.</p>
  }
  return (
    <div className="space-y-3">
      <div
        role="img"
        aria-label={`${label}: ${segments
          .map((s) => `${s.name} ${s.count}`)
          .join(', ')}`}
        className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full"
      >
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <span
              key={s.name}
              className={cn(
                'h-full first:rounded-l-full last:rounded-r-full',
                s.className,
              )}
              style={{ width: `${(s.count / total) * 100}%` }}
            />
          ))}
      </div>
      <ul className="grid gap-1.5 text-sm">
        {segments.map((s) => (
          <li key={s.name} className="flex items-center gap-2">
            <span className={cn('size-2.5 shrink-0 rounded-sm', s.className)} />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="tabular-nums">{s.count}</span>
            <span className="text-muted-foreground w-10 text-right text-xs tabular-nums">
              {Math.round((s.count / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
