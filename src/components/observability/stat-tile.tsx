import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

import { InfoTip } from '@/components/ui/info-tip'
import { cn } from '@/lib/utils'

/**
 * One number on the Overview (spec 0042 FR10), in the manner of
 * shadcnui-blocks' Stats Grid on 21st.dev (MIT): a label, the value, how it
 * moved against the previous window, and a small trend line. Whether "up" is
 * good depends on the number, so the colour follows `better`.
 */
export function StatTile({
  label,
  value,
  current,
  previous,
  better,
  series,
  help,
}: {
  label: string
  value: string
  current: number | null
  previous: number | null
  /** Which way is an improvement. */
  better: 'up' | 'down'
  series: (number | null)[]
  help: string
}) {
  const change =
    current !== null && previous !== null && previous !== 0
      ? (current - previous) / Math.abs(previous)
      : null
  const flat = change === null || Math.abs(change) < 0.005
  const improved = !flat && change! > 0 === (better === 'up')

  return (
    <div className="bg-background flex min-w-0 flex-col gap-1 p-4">
      <div className="text-muted-foreground flex items-center gap-1 text-xs">
        {label}
        <InfoTip title={label}>
          <p>{help}</p>
        </InfoTip>
      </div>
      <div className="flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </p>
        <Sparkline series={series} />
      </div>
      <p
        className={cn(
          'flex items-center gap-1 text-xs',
          flat
            ? 'text-muted-foreground'
            : improved
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-red-700 dark:text-red-400',
        )}
      >
        {change === null ? (
          <span className="text-muted-foreground">No earlier data</span>
        ) : (
          <>
            {flat ? (
              <Minus className="size-3" aria-hidden />
            ) : change > 0 ? (
              <ArrowUpRight className="size-3" aria-hidden />
            ) : (
              <ArrowDownRight className="size-3" aria-hidden />
            )}
            {flat
              ? 'No change'
              : `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change * 100).toFixed(0)}%`}
            <span className="text-muted-foreground">vs previous</span>
          </>
        )}
      </p>
    </div>
  )
}

/** A tiny trend line; gaps where there was no data. Decorative. */
function Sparkline({ series }: { series: (number | null)[] }) {
  const values = series.filter((v): v is number => v !== null)
  if (values.length < 2) return <span className="h-8 w-24" aria-hidden />
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const w = 96
  const h = 32
  const step = w / Math.max(series.length - 1, 1)
  let d = ''
  let pen = false
  series.forEach((v, i) => {
    if (v === null) {
      pen = false
      return
    }
    const x = i * step
    const y = h - 3 - ((v - min) / span) * (h - 6)
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `
    pen = true
  })
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
      className="shrink-0 overflow-visible text-orange-500"
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
