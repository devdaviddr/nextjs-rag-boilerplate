'use client'

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { Bucket, Range } from '@/lib/observability/telemetry'

import { duration } from './format'

/**
 * The Overview's charts (spec 0042 FR10), on Recharts, which only this page
 * loads. Colours match the rest of Observability: answered green, no match
 * amber, failed red; the median orange and the slow tail slate.
 */

const COLOR = {
  answered: '#10b981',
  refused: '#f59e0b',
  failed: '#ef4444',
  p50: '#f97316',
  p95: '#64748b',
  bar: '#14b8a6',
}

function tick(range: Range) {
  return (iso: string) => {
    const d = new Date(iso)
    return range === '24h'
      ? d.toLocaleTimeString([], { hour: '2-digit', hour12: false })
      : d.toLocaleDateString([], { weekday: 'short' })
  }
}

const axis = {
  stroke: 'currentColor',
  tick: { fill: 'currentColor', fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const

function Frame({
  title,
  children,
  summary,
}: {
  title: string
  summary: string
  children: React.ReactElement
}) {
  return (
    <figure className="bg-background rounded-lg border p-4">
      <figcaption className="mb-3 text-sm font-medium">{title}</figcaption>
      {/* Recharts makes the chart keyboard-navigable; the summary says in
          words what it shows. */}
      <p className="sr-only">{summary}</p>
      <div className="text-muted-foreground h-56">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </figure>
  )
}

const tooltipStyle = {
  contentStyle: {
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--popover-foreground)',
    fontSize: 12,
  },
  labelStyle: { color: 'var(--muted-foreground)' },
}

export function QuestionsChart({
  buckets,
  range,
}: {
  buckets: Bucket[]
  range: Range
}) {
  const total = buckets.reduce(
    (sum, b) => sum + b.answered + b.refused + b.failed,
    0,
  )
  return (
    <Frame
      title="Questions over time"
      summary={`${total} questions in this window, by outcome.`}
    >
      <BarChart
        data={buckets}
        margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
      >
        <CartesianGrid vertical={false} strokeOpacity={0.15} />
        <XAxis
          dataKey="start"
          tickFormatter={tick(range)}
          {...axis}
          minTickGap={16}
        />
        <YAxis allowDecimals={false} {...axis} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(v) => new Date(String(v)).toLocaleString()}
          cursor={{ fillOpacity: 0.06 }}
        />
        <Legend
          iconType="square"
          iconSize={8}
          wrapperStyle={{ fontSize: 12 }}
        />
        <Bar
          dataKey="answered"
          name="Answered"
          stackId="q"
          fill={COLOR.answered}
        />
        <Bar
          dataKey="refused"
          name="No match"
          stackId="q"
          fill={COLOR.refused}
        />
        <Bar
          dataKey="failed"
          name="Failed"
          stackId="q"
          fill={COLOR.failed}
          radius={[2, 2, 0, 0]}
        />
      </BarChart>
    </Frame>
  )
}

export function LatencyChart({
  buckets,
  range,
}: {
  buckets: Bucket[]
  range: Range
}) {
  return (
    <Frame
      title="How long answers take"
      summary="Median and slowest 5% of answer times over the window."
    >
      <LineChart
        data={buckets}
        margin={{ top: 4, right: 4, left: -8, bottom: 0 }}
      >
        <CartesianGrid vertical={false} strokeOpacity={0.15} />
        <XAxis
          dataKey="start"
          tickFormatter={tick(range)}
          {...axis}
          minTickGap={16}
        />
        <YAxis
          {...axis}
          tickFormatter={(v: number) => duration(v)}
          width={56}
        />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(v) => new Date(String(v)).toLocaleString()}
          formatter={(v) => duration(Number(v))}
        />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
        <Line
          dataKey="p50Ms"
          name="Median"
          stroke={COLOR.p50}
          strokeWidth={2}
          dot={{ r: 2.5 }}
          activeDot={{ r: 4 }}
          connectNulls
        />
        <Line
          dataKey="p95Ms"
          name="Slowest 5%"
          stroke={COLOR.p95}
          strokeWidth={2}
          strokeDasharray="4 3"
          dot={{ r: 2.5 }}
          activeDot={{ r: 4 }}
          connectNulls
        />
        <Line
          dataKey="ttftP50Ms"
          name="First word (median)"
          stroke={COLOR.bar}
          strokeWidth={2}
          dot={{ r: 2.5 }}
          activeDot={{ r: 4 }}
          connectNulls
        />
      </LineChart>
    </Frame>
  )
}

export function SimilarityChart({
  bins,
  floor,
}: {
  bins: { bin: number; count: number }[]
  floor: number
}) {
  const data = bins.map((b) => ({
    label: (b.bin / 20).toFixed(2),
    count: b.count,
  }))
  const below = bins
    .filter((b) => (b.bin + 1) / 20 <= floor)
    .reduce((sum, b) => sum + b.count, 0)
  return (
    <Frame
      title="Best match per question, against the floor"
      summary={`How similar the best passage was for each question. ${below} questions scored below the floor of ${floor}.`}
    >
      <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.15} />
        <XAxis dataKey="label" {...axis} interval={3} />
        <YAxis allowDecimals={false} {...axis} />
        <Tooltip {...tooltipStyle} cursor={{ fillOpacity: 0.06 }} />
        <ReferenceLine
          x={(Math.floor(floor * 20) / 20).toFixed(2)}
          stroke={COLOR.refused}
          strokeDasharray="4 3"
          label={{
            value: `floor ${floor}`,
            position: 'insideTopRight',
            fill: 'currentColor',
            fontSize: 11,
          }}
        />
        <Bar
          dataKey="count"
          name="Questions"
          fill={COLOR.bar}
          radius={[2, 2, 0, 0]}
        />
      </BarChart>
    </Frame>
  )
}
