'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Circle, Loader2, Pause, Play, RotateCcw, X } from 'lucide-react'

import type { RunStep } from '@/lib/observability/queries'
import { cn } from '@/lib/utils'

import { STEP_LABEL, duration } from './format'

/**
 * A run's steps as a waterfall you can replay (spec 0042 FR9), in the manner
 * of NIMA MZ's Agent Trace on 21st.dev (MIT): drag the playhead, or press
 * play, and steps go from waiting to running to done while the token count
 * builds. Click a step for what it did.
 */

type Phase = 'queued' | 'running' | 'done'

interface Row extends RunStep {
  depth: number
  offset: number
}

/** Colour by what kind of work a step is. */
function tone(name: string): string {
  if (name === 'plan' || name === 'read-figure') return 'bg-orange-500'
  if (name === 'draft' || name === 'verify') return 'bg-violet-500'
  if (['download', 'extract', 'embed', 'store'].includes(name))
    return 'bg-emerald-500'
  return 'bg-teal-500'
}

const SPEEDS = [1, 4, 16] as const

function StepDetails({ step }: { step: Row }) {
  const { passages, answer, passage, error, ...rest } = step.attributes as {
    passages?: {
      document: string
      page: number
      similarity: number
      text: string
    }[]
    answer?: string
    passage?: string
    error?: string
    [key: string]: unknown
  }
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="font-semibold">{STEP_LABEL[step.name] ?? step.name}</h3>
        <span className="text-muted-foreground">
          {duration(step.durationMs)}
          {step.model && (
            <>
              {' '}
              · <span className="font-mono">{step.model}</span>
            </>
          )}
          {step.tokens ? <> · {step.tokens.toLocaleString()} tokens</> : null}
        </span>
      </div>
      {error && (
        <p className="rounded-md bg-red-50 p-2 text-red-800 dark:bg-red-500/10 dark:text-red-300">
          {String(error)}
        </p>
      )}
      {Object.keys(rest).length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          {Object.entries(rest).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-mono text-xs break-words">
                {typeof v === 'string' ? v : JSON.stringify(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {typeof passage === 'string' && (
        <div>
          <p className="text-muted-foreground mb-1 text-xs">Drafted passage</p>
          <p className="bg-muted/40 rounded-md p-2 whitespace-pre-wrap">
            {passage}
          </p>
        </div>
      )}
      {Array.isArray(passages) && passages.length > 0 && (
        <div>
          <p className="text-muted-foreground mb-1 text-xs">
            What it found (top {passages.length})
          </p>
          <ol className="space-y-2">
            {passages.map((p, i) => (
              <li key={i} className="bg-muted/40 rounded-md p-2">
                <p className="text-muted-foreground text-xs">
                  {p.document}, page {p.page} · similarity{' '}
                  {p.similarity.toFixed(2)}
                </p>
                <p className="mt-1 line-clamp-4">{p.text}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
      {typeof answer === 'string' && (
        <div>
          <p className="text-muted-foreground mb-1 text-xs">The answer</p>
          <p className="bg-muted/40 max-h-64 overflow-auto rounded-md p-2 whitespace-pre-wrap">
            {answer}
          </p>
        </div>
      )}
    </div>
  )
}

export function RunTrace({
  steps,
  startedAt,
  totalMs,
}: {
  steps: RunStep[]
  startedAt: string
  totalMs: number
}) {
  const runStart = new Date(startedAt).getTime()
  const total = Math.max(
    totalMs,
    ...steps.map(
      (s) => new Date(s.startedAt).getTime() - runStart + s.durationMs,
    ),
    1,
  )

  const rows: Row[] = useMemo(() => {
    const byKey = new Map(steps.map((s) => [s.key, s]))
    const depthOf = (s: RunStep): number => {
      let depth = 0
      let parent = s.parentKey !== null ? byKey.get(s.parentKey) : undefined
      while (parent && depth < 10) {
        depth++
        parent =
          parent.parentKey !== null ? byKey.get(parent.parentKey) : undefined
      }
      return depth
    }
    return steps.map((s) => ({
      ...s,
      depth: depthOf(s),
      offset: Math.max(0, new Date(s.startedAt).getTime() - runStart),
    }))
  }, [steps, runStart])

  const [t, setT] = useState(total)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4)
  const [selected, setSelected] = useState<number | null>(
    rows.find((r) => r.status === 'error')?.key ?? rows[0]?.key ?? null,
  )
  const frame = useRef<number | null>(null)

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) * speed
      last = now
      setT((prev) => {
        const next = prev + dt
        if (next >= total) {
          setPlaying(false)
          return total
        }
        return next
      })
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
    }
  }, [playing, speed, total])

  const phaseOf = (r: Row): Phase =>
    t < r.offset ? 'queued' : t < r.offset + r.durationMs ? 'running' : 'done'

  const tokens = rows.reduce((sum, r) => {
    if (!r.tokens) return sum
    const phase = phaseOf(r)
    if (phase === 'done') return sum + r.tokens
    if (phase === 'running' && r.durationMs > 0)
      return sum + Math.round((r.tokens * (t - r.offset)) / r.durationMs)
    return sum
  }, 0)

  const pct = (ms: number) => `${Math.min(100, (ms / total) * 100)}%`
  const active = rows.find((r) => r.key === selected) ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            if (t >= total) setT(0)
            setPlaying(!playing)
          }}
          className="bg-foreground text-background inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium"
        >
          {playing ? (
            <>
              <Pause className="size-3.5" /> Pause
            </>
          ) : (
            <>
              <Play className="size-3.5" /> Replay
            </>
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false)
            setT(0)
          }}
          aria-label="Back to the start"
          className="text-muted-foreground hover:text-foreground inline-flex size-8 items-center justify-center rounded-md border"
        >
          <RotateCcw className="size-3.5" />
        </button>
        <div role="group" aria-label="Replay speed" className="flex gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={speed === s}
              onClick={() => setSpeed(s)}
              className={cn(
                'h-8 rounded-md border px-2 text-xs tabular-nums',
                speed === s
                  ? 'border-foreground font-medium'
                  : 'text-muted-foreground',
              )}
            >
              {s}×
            </button>
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={total}
          step={Math.max(1, Math.round(total / 500))}
          value={Math.round(t)}
          onChange={(e) => {
            setPlaying(false)
            setT(Number(e.target.value))
          }}
          aria-label="Replay position"
          aria-valuetext={`${duration(Math.round(t))} of ${duration(total)}`}
          className="min-w-40 flex-1 accent-orange-500"
        />
        <span className="text-muted-foreground text-xs tabular-nums">
          {duration(Math.round(t))} / {duration(total)} ·{' '}
          <span className="text-foreground font-medium">
            {tokens.toLocaleString()}
          </span>{' '}
          tokens
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <div className="bg-muted/40 text-muted-foreground grid grid-cols-[minmax(11rem,16rem)_1fr] border-b text-[10px] tabular-nums">
          <span className="px-3 py-1.5">Step</span>
          <div className="relative h-6">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <span
                key={f}
                className="absolute top-1.5 -translate-x-1/2 whitespace-nowrap first:translate-x-0 last:-translate-x-full"
                style={{ left: `${f * 100}%` }}
              >
                {duration(Math.round(total * f))}
              </span>
            ))}
          </div>
        </div>
        <ul>
          {rows.map((r) => {
            const phase = phaseOf(r)
            const failed = phase === 'done' && r.status === 'error'
            const cancelled = phase === 'done' && r.status === 'cancelled'
            const fill =
              phase === 'queued'
                ? 0
                : phase === 'running'
                  ? (t - r.offset) / Math.max(r.durationMs, 1)
                  : 1
            return (
              <li key={r.key}>
                <button
                  type="button"
                  aria-pressed={selected === r.key}
                  onClick={() => setSelected(r.key)}
                  className={cn(
                    'hover:bg-muted/50 grid w-full grid-cols-[minmax(11rem,16rem)_1fr] items-center text-left',
                    selected === r.key && 'bg-muted/60',
                  )}
                >
                  <span
                    className="flex min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs"
                    style={{ paddingLeft: `${0.75 + r.depth * 1}rem` }}
                  >
                    {phase === 'queued' ? (
                      <Circle
                        className="text-muted-foreground size-3 shrink-0"
                        aria-label="Waiting"
                      />
                    ) : phase === 'running' ? (
                      <Loader2
                        className="size-3 shrink-0 animate-spin text-orange-500"
                        aria-label="Running"
                      />
                    ) : failed ? (
                      <X
                        className="size-3 shrink-0 text-red-600"
                        aria-label="Failed"
                      />
                    ) : cancelled ? (
                      <X
                        className="text-muted-foreground size-3 shrink-0"
                        aria-label="Cancelled"
                      />
                    ) : (
                      <Check
                        className="size-3 shrink-0 text-emerald-600"
                        aria-label="Done"
                      />
                    )}
                    <span className="truncate font-medium">
                      {STEP_LABEL[r.name] ?? r.name}
                    </span>
                    <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">
                      {duration(r.durationMs)}
                    </span>
                  </span>
                  <span className="relative block h-7" aria-hidden>
                    <span
                      className={cn(
                        'absolute top-1.5 h-4 rounded-sm border',
                        phase === 'queued'
                          ? 'border-dashed border-slate-300 dark:border-slate-600'
                          : 'border-transparent',
                      )}
                      style={{
                        left: pct(r.offset),
                        width: `max(${pct(r.durationMs)}, 3px)`,
                      }}
                    >
                      <span
                        className={cn(
                          'absolute inset-y-0 left-0 rounded-sm',
                          failed
                            ? 'bg-red-500'
                            : cancelled
                              ? 'bg-slate-400'
                              : tone(r.name),
                          phase === 'running' && 'animate-pulse',
                        )}
                        style={{ width: `${fill * 100}%` }}
                      />
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-orange-500" /> Agent
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-teal-500" /> Retrieval
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-violet-500" /> Writing and
          checking
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-emerald-500" /> Ingestion
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-red-500" /> Failed
        </span>
      </div>

      {active && (
        <section
          aria-label="Step details"
          className="bg-background rounded-lg border p-4"
        >
          <StepDetails step={active} />
        </section>
      )}
    </div>
  )
}
