'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Activity, Check, ChevronDown, Circle, Loader2, X } from 'lucide-react'

import {
  CATEGORY_STYLE,
  LEVEL_STYLE,
} from '@/components/observability/log-style'
import { STEP_LABEL, duration } from '@/components/observability/format'
import { useRole } from '@/lib/auth/client-rbac'
import type { LogCategory } from '@/lib/logger'
import type {
  ActivityEvent,
  ActivityLine,
  ActivityStep,
} from '@/lib/observability/activity'
import { cn } from '@/lib/utils'

/**
 * The Agent activity drawer under an answer (spec 0042 FR12). Closed by
 * default. Open while the answer is being written, it follows it live: each
 * step as it starts and ends, and a plain line for each thing that happened.
 * Open on an older answer, it loads what was recorded.
 */

/** An event as the chat received it, stamped with when it arrived. */
export type LiveActivity = ActivityEvent & { receivedAt: number }

/**
 * What a drawer has seen and whether it is open, by request id, for the life
 * of the tab. When a new chat's first answer finishes, the page moves to the
 * conversation's own URL and the chat view mounts afresh; without this the
 * drawer would close and forget the run it just watched.
 */
const seen = new Map<string, LiveActivity[]>()
const opened = new Map<string, boolean>()

interface Step {
  key: number
  parentKey: number | null
  name: string
  offsetMs: number
  durationMs: number | null
  status: ActivityStep['status'] | 'running'
  model: string | null
  tokens: number | null
  /** Client time the start arrived, to show a running step's elapsed time. */
  startedAt: number
}

function build(events: (ActivityEvent & { receivedAt?: number })[]) {
  const steps = new Map<number, Step>()
  const lines: ActivityLine[] = []
  for (const e of events) {
    if (e.kind === 'line') {
      lines.push(e)
      continue
    }
    const existing = steps.get(e.key)
    if (e.phase === 'start' || !existing) {
      steps.set(e.key, {
        key: e.key,
        parentKey: e.parentKey,
        name: e.name,
        offsetMs: e.offsetMs,
        durationMs: e.phase === 'end' ? (e.durationMs ?? null) : null,
        status: e.phase === 'end' ? (e.status ?? 'ok') : 'running',
        model: e.model ?? null,
        tokens: e.tokens ?? null,
        startedAt: e.receivedAt ?? 0,
      })
    }
    if (e.phase === 'end' && existing) {
      existing.durationMs = e.durationMs ?? null
      existing.status = e.status ?? 'ok'
      existing.model = e.model ?? existing.model
      existing.tokens = e.tokens ?? existing.tokens
    }
  }
  const ordered = [...steps.values()].sort((a, b) => a.key - b.key)
  const byKey = new Map(ordered.map((s) => [s.key, s]))
  const depth = (s: Step) => {
    let d = 0
    let p = s.parentKey !== null ? byKey.get(s.parentKey) : undefined
    while (p && d < 6) {
      d++
      p = p.parentKey !== null ? byKey.get(p.parentKey) : undefined
    }
    return d
  }
  return { steps: ordered.map((s) => ({ ...s, depth: depth(s) })), lines }
}

interface History {
  steps: ActivityStep[]
  lines: ActivityLine[]
  startedAt: string | null
}

export function AgentActivity({
  requestId,
  live,
  events,
}: {
  requestId: string | null
  /** The answer is still being built. */
  live: boolean
  events: LiveActivity[] | undefined
}) {
  const [open, setOpenState] = useState(
    () => !!requestId && !!opened.get(requestId),
  )
  const setOpen = (next: boolean) => {
    if (requestId) opened.set(requestId, next)
    setOpenState(next)
  }
  if (requestId && events?.length) seen.set(requestId, events)
  const liveEvents = events?.length
    ? events
    : requestId
      ? seen.get(requestId)
      : undefined
  const [history, setHistory] = useState<History | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const isAdmin = useRole().includes('admin')

  // Older answers have no live events: load what was recorded, once opened.
  const needsHistory = open && !liveEvents?.length && !!requestId && !history
  useEffect(() => {
    if (!needsHistory) return
    const controller = new AbortController()
    fetch(`/api/chat/activity?requestId=${encodeURIComponent(requestId!)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setHistory((await res.json()) as History)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(
            err instanceof Error && err.message === 'HTTP 404'
              ? 'Nothing was recorded for this answer.'
              : 'Could not load the activity.',
          )
        }
      })
    return () => controller.abort()
  }, [needsHistory, requestId])

  const { steps, lines } = useMemo(
    () =>
      build(
        liveEvents?.length
          ? liveEvents
          : history
            ? [...history.steps, ...history.lines]
            : [],
      ),
    [liveEvents, history],
  )
  const running = steps.filter((s) => s.status === 'running')

  // Tick while something is running and the drawer is open, so elapsed times move.
  useEffect(() => {
    if (!open || running.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [open, running.length])

  const total = Math.max(
    1,
    ...steps.map(
      (s) =>
        s.offsetMs +
        (s.durationMs ?? (s.startedAt ? Math.max(0, now - s.startedAt) : 0)),
    ),
  )
  const topLevel = steps.filter((s) => s.parentKey === null)
  const finishedMs = topLevel.length
    ? Math.max(...topLevel.map((s) => s.offsetMs + (s.durationMs ?? 0)))
    : null

  const summary = live
    ? running.length > 0
      ? `Working: ${STEP_LABEL[running.at(-1)!.name] ?? running.at(-1)!.name}…`
      : 'Working…'
    : steps.length > 0
      ? `${topLevel.length} step${topLevel.length === 1 ? '' : 's'} · ${duration(finishedMs)}`
      : lines.length > 0
        ? `${lines.length} event${lines.length === 1 ? '' : 's'}`
        : 'See what happened'

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md py-0.5 text-xs"
      >
        {live ? (
          <Loader2
            className="size-3.5 animate-spin text-orange-500"
            aria-hidden
          />
        ) : (
          <Activity className="size-3.5" aria-hidden />
        )}
        Agent activity
        <span className="text-muted-foreground">· {summary}</span>
        <ChevronDown
          className={cn('size-3.5 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      {open && (
        <section
          aria-label="Agent activity"
          className="bg-muted/30 mt-2 space-y-3 rounded-lg border p-3"
        >
          {loadError && (
            <p className="text-muted-foreground text-xs">{loadError}</p>
          )}
          {!loadError && steps.length === 0 && lines.length === 0 && (
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              {live || needsHistory ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Waiting for the
                  first step…
                </>
              ) : (
                'Nothing was recorded for this answer.'
              )}
            </p>
          )}

          {steps.length > 0 && (
            <ol aria-label="Steps" className="space-y-0.5">
              {steps.map((s) => {
                const elapsed =
                  s.durationMs ??
                  (s.startedAt ? Math.max(0, now - s.startedAt) : null)
                return (
                  <li
                    key={s.key}
                    className="grid grid-cols-[minmax(9rem,14rem)_1fr_auto] items-center gap-2 text-xs"
                  >
                    <span
                      className="flex min-w-0 items-center gap-1.5"
                      style={{ paddingLeft: `${s.depth * 0.9}rem` }}
                    >
                      {s.status === 'running' ? (
                        <Loader2
                          className="size-3 shrink-0 animate-spin text-orange-500"
                          aria-label="Running"
                        />
                      ) : s.status === 'error' ? (
                        <X
                          className="size-3 shrink-0 text-red-600"
                          aria-label="Failed"
                        />
                      ) : s.status === 'cancelled' ? (
                        <Circle
                          className="text-muted-foreground size-3 shrink-0"
                          aria-label="Cancelled"
                        />
                      ) : (
                        <Check
                          className="size-3 shrink-0 text-emerald-600"
                          aria-label="Done"
                        />
                      )}
                      <span className="truncate">
                        {STEP_LABEL[s.name] ?? s.name}
                      </span>
                    </span>
                    <span
                      className="bg-muted relative h-1.5 rounded-full"
                      aria-hidden
                    >
                      <span
                        className={cn(
                          'absolute inset-y-0 rounded-full',
                          s.status === 'error'
                            ? 'bg-red-500'
                            : s.status === 'running'
                              ? 'animate-pulse bg-orange-400'
                              : 'bg-orange-500',
                        )}
                        style={{
                          left: `${(s.offsetMs / total) * 100}%`,
                          width: `max(${((elapsed ?? 0) / total) * 100}%, 2px)`,
                        }}
                      />
                    </span>
                    <span className="text-muted-foreground w-16 text-right tabular-nums">
                      {elapsed !== null ? duration(Math.round(elapsed)) : '–'}
                    </span>
                  </li>
                )
              })}
            </ol>
          )}

          {lines.length > 0 && (
            <ul aria-label="What happened" className="space-y-1 border-t pt-2">
              {lines.map((line, i) => {
                const category =
                  CATEGORY_STYLE[line.category as LogCategory] ??
                  CATEGORY_STYLE.system
                const level = LEVEL_STYLE[line.level] ?? LEVEL_STYLE.info
                return (
                  <li
                    key={i}
                    className={cn('border-l-2 pl-2 text-xs', category.stripe)}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={cn(
                          'mt-1 size-1.5 shrink-0 rounded-full',
                          level.dot,
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="sr-only">
                          {level.label}, {category.label}:{' '}
                        </span>
                        {line.text}
                      </span>
                      <span
                        className={cn('shrink-0 text-[10px]', category.text)}
                        aria-hidden
                      >
                        {category.label}
                      </span>
                    </div>
                    {line.detail && (
                      <details className="mt-0.5 ml-3.5">
                        <summary className="text-muted-foreground cursor-pointer text-[11px]">
                          Details
                        </summary>
                        <pre className="bg-background mt-1 max-h-48 overflow-auto rounded border p-2 text-[10px] whitespace-pre-wrap">
                          {JSON.stringify(line.detail, null, 2)}
                        </pre>
                      </details>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {isAdmin && requestId && !live && (
            <p className="flex flex-wrap gap-3 border-t pt-2 text-xs">
              <Link
                href={`/observability/runs/${requestId}`}
                className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              >
                Open the full run
              </Link>
              <Link
                href={`/observability/logs?requestId=${requestId}`}
                className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              >
                All log lines
              </Link>
            </p>
          )}
        </section>
      )}
    </div>
  )
}
