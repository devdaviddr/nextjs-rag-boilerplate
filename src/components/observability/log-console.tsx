'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ArrowDown,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  Search,
  X,
} from 'lucide-react'

import { InfoTip } from '@/components/ui/info-tip'
import type { LogCategory } from '@/lib/logger'
import type { LogLine } from '@/lib/observability/queries'
import { cn } from '@/lib/utils'

import { CATEGORY_STYLE, LEVEL_STYLE, type LogLevel } from './log-style'

/**
 * Observability → Logs (spec 0042 FR7). A console in the manner of hirael's
 * Log Viewer on 21st.dev (MIT): newest at the bottom, severity colours, level
 * toggles with live counts, and a follow mode that lets go when you scroll up.
 * Added here: category stripes, search, a line's full details, and every line
 * of one request at a click.
 */

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug']
const CATEGORIES = Object.keys(CATEGORY_STYLE) as LogCategory[]
const POLL_MS = 2_000
/** Lines kept in the browser; older ones are dropped as new ones arrive. */
const MAX_LINES = 2_000

type Counts = Record<LogLevel, number>

interface Page {
  lines: LogLine[]
  hasOlder: boolean
  counts: Counts | null
}

function time(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function preview(meta: Record<string, unknown>): string {
  return Object.entries(meta)
    .filter(([k]) => k !== 'conversationId' && k !== 'documentId')
    .slice(0, 4)
    .map(([k, v]) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}=${text && text.length > 60 ? `${text.slice(0, 60)}…` : text}`
    })
    .join('  ')
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value]
}

function LogRow({
  line,
  onRequest,
}: {
  line: LogLine
  onRequest: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const level = LEVEL_STYLE[line.level] ?? LEVEL_STYLE.info
  const category = CATEGORY_STYLE[line.category] ?? CATEGORY_STYLE.system
  const details = preview(line.meta)

  return (
    <li
      data-level={line.level}
      data-category={line.category}
      className={cn(
        'hover:bg-muted/60 border-l-[3px]',
        category.stripe,
        line.level === 'error' && 'bg-red-50/60 dark:bg-red-500/5',
        line.level === 'warn' && 'bg-amber-50/50 dark:bg-amber-500/5',
      )}
    >
      <div className="flex items-start gap-2 px-2 py-1">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} details: ${line.message}`}
          onClick={() => setOpen(!open)}
          className="text-muted-foreground hover:text-foreground mt-0.5 shrink-0"
        >
          <ChevronRight
            className={cn('size-3.5 transition-transform', open && 'rotate-90')}
          />
        </button>
        <time
          dateTime={line.time}
          className="text-muted-foreground shrink-0 tabular-nums"
        >
          {time(line.time)}
        </time>
        <span
          className={cn(
            'inline-flex w-12 shrink-0 justify-center rounded px-1 font-sans text-[10px] font-semibold uppercase ring-1 ring-inset',
            level.badge,
          )}
        >
          {level.label}
        </span>
        <span
          className={cn(
            'hidden w-[4.5rem] shrink-0 font-sans text-[11px] font-medium sm:inline',
            category.text,
          )}
        >
          {category.label}
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-foreground">{line.message}</span>
          {details && (
            <span className="text-muted-foreground ml-2 break-all">
              {details}
            </span>
          )}
        </span>
        {line.requestId && (
          <button
            type="button"
            onClick={() => onRequest(line.requestId!)}
            title="Show every line from this request"
            className="text-muted-foreground hover:text-foreground hidden shrink-0 rounded border px-1 font-sans text-[10px] md:inline"
          >
            req {line.requestId.slice(0, 8)}
          </button>
        )}
      </div>
      {open && (
        <div className="pb-2 pl-8">
          <dl className="text-muted-foreground mb-1 flex flex-wrap gap-x-4 font-sans text-[11px]">
            <div>
              <dt className="inline">Category: </dt>
              <dd className={cn('inline', category.text)}>{category.label}</dd>
            </div>
            {line.requestId && (
              <div>
                <dt className="inline">Request: </dt>
                <dd className="inline font-mono">{line.requestId}</dd>
              </div>
            )}
            {line.userId && (
              <div>
                <dt className="inline">User: </dt>
                <dd className="inline font-mono">{line.userId}</dd>
              </div>
            )}
          </dl>
          <pre className="bg-background max-h-80 overflow-auto rounded border p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
            {JSON.stringify(line.meta, null, 2)}
          </pre>
        </div>
      )}
    </li>
  )
}

export function LogConsole({
  initialRequestId,
}: {
  initialRequestId: string | null
}) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [counts, setCounts] = useState<Counts | null>(null)
  const [levels, setLevels] = useState<LogLevel[]>([])
  const [categories, setCategories] = useState<LogCategory[]>([])
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')
  const [requestId, setRequestId] = useState<string | null>(initialRequestId)
  const [live, setLive] = useState(true)
  const [follow, setFollow] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const lastId = useRef(0)

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const filterParams = useMemo(() => {
    const p = new URLSearchParams()
    if (levels.length) p.set('levels', levels.join(','))
    if (categories.length) p.set('categories', categories.join(','))
    if (q) p.set('q', q)
    if (requestId) p.set('requestId', requestId)
    return p.toString()
  }, [levels, categories, q, requestId])

  const fetchPage = useCallback(
    async (extra: Record<string, string>, signal?: AbortSignal) => {
      const p = new URLSearchParams(filterParams)
      for (const [k, v] of Object.entries(extra)) p.set(k, v)
      const res = await fetch(`/api/observability/logs?${p}`, { signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as Page
    },
    [filterParams],
  )

  // A new set of filters starts from the newest page.
  useEffect(() => {
    const controller = new AbortController()
    fetchPage({ counts: '1' }, controller.signal)
      .then((page) => {
        setLines(page.lines)
        setHasOlder(page.hasOlder)
        setCounts(page.counts)
        setError(null)
        setFollow(true)
        lastId.current = page.lines.at(-1)?.id ?? 0
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [fetchPage])

  // The live tail: anything newer than the last line shown.
  useEffect(() => {
    if (!live) return
    let tick = 0
    const timer = setInterval(() => {
      tick++
      fetchPage({
        after: String(lastId.current),
        ...(tick % 5 === 0 ? { counts: '1' } : {}),
      })
        .then((page) => {
          if (page.counts) setCounts(page.counts)
          if (page.lines.length === 0) return
          lastId.current = page.lines.at(-1)!.id
          setLines((current) => [...current, ...page.lines].slice(-MAX_LINES))
          setError(null)
        })
        .catch(() => setError('Lost contact with the server; retrying.'))
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [live, fetchPage])

  // Following keeps the newest line in view.
  useLayoutEffect(() => {
    const el = scroller.current
    if (follow && el) el.scrollTop = el.scrollHeight
  }, [lines, follow])

  const loadOlder = () => {
    const first = lines[0]?.id
    if (!first) return
    const el = scroller.current
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0
    fetchPage({ before: String(first) })
      .then((page) => {
        setFollow(false)
        setHasOlder(page.hasOlder)
        setLines((current) => [...page.lines, ...current].slice(0, MAX_LINES))
        // Keep the reader's place after the older lines arrive above it.
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - fromBottom
        })
      })
      .catch((err: unknown) => setError(String(err)))
  }

  const jumpToLatest = () => {
    setFollow(true)
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Levels" className="flex flex-wrap gap-1">
          {LEVELS.map((level) => {
            const on = levels.length === 0 || levels.includes(level)
            return (
              <button
                key={level}
                type="button"
                aria-pressed={levels.includes(level)}
                onClick={() => setLevels(toggle(levels, level))}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                  on ? 'bg-background' : 'text-muted-foreground bg-muted/40',
                  levels.includes(level) && 'border-foreground',
                )}
              >
                {/* Hollow when filtered out: shape, not just fading. */}
                <span
                  className={cn(
                    'size-2 rounded-full',
                    on
                      ? LEVEL_STYLE[level].dot
                      : 'ring-muted-foreground/60 ring-1 ring-inset',
                  )}
                />
                {LEVEL_STYLE[level].label}
                <span className="text-muted-foreground tabular-nums">
                  {counts ? counts[level].toLocaleString() : '–'}
                </span>
              </button>
            )
          })}
          <InfoTip title="Levels">
            <p>
              How serious a line is. Errors are things that failed, warnings are
              things that went wrong but were handled (a retry, a fallback),
              info is the normal story of what happened, and debug is extra
              detail.
            </p>
            <p>Counts are for the last 24 hours. Pick one or more to filter.</p>
          </InfoTip>
        </div>

        <div
          role="group"
          aria-label="Categories"
          className="flex flex-wrap gap-1"
        >
          {CATEGORIES.map((category) => {
            const style = CATEGORY_STYLE[category]
            return (
              <button
                key={category}
                type="button"
                aria-pressed={categories.includes(category)}
                title={style.help}
                onClick={() => setCategories(toggle(categories, category))}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                  categories.includes(category)
                    ? 'border-foreground bg-background'
                    : 'text-muted-foreground',
                )}
              >
                <span className={cn('h-3 w-1 rounded-full', style.chip)} />
                {style.label}
              </button>
            )
          })}
        </div>

        <div className="relative ml-auto w-full sm:w-64">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages and details"
            aria-label="Search logs"
            className="border-input bg-background focus-visible:ring-ring/50 h-8 w-full rounded-md border pr-2 pl-8 text-sm outline-none focus-visible:ring-[3px]"
          />
        </div>

        <button
          type="button"
          onClick={() => setLive(!live)}
          aria-pressed={live}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium',
            live
              ? 'border-emerald-600/30 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'bg-background',
          )}
        >
          {live ? (
            <>
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
              Live <Pause className="size-3" />
            </>
          ) : (
            <>
              Paused <Play className="size-3" />
            </>
          )}
        </button>
      </div>

      {requestId && (
        <div className="bg-muted/50 flex items-center gap-2 rounded-md px-3 py-1.5 text-sm">
          Showing one request:
          <code className="text-xs">{requestId}</code>
          <button
            type="button"
            onClick={() => setRequestId(null)}
            className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
          >
            <X className="size-3.5" /> Show all
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          role="log"
          aria-label="Log lines"
          aria-live="off"
          onScroll={(e) => {
            const el = e.currentTarget
            const atBottom =
              el.scrollHeight - el.scrollTop - el.clientHeight < 40
            if (atBottom !== follow) setFollow(atBottom)
          }}
          className="bg-muted/20 min-h-0 flex-1 overflow-y-auto rounded-lg border font-mono text-xs"
        >
          {hasOlder && (
            <div className="border-b p-2 text-center">
              <button
                type="button"
                onClick={loadOlder}
                className="text-muted-foreground hover:text-foreground font-sans text-xs underline-offset-2 hover:underline"
              >
                Load older lines
              </button>
            </div>
          )}
          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 p-4 font-sans text-sm">
              <Loader2 className="size-4 animate-spin" /> Loading logs…
            </p>
          ) : lines.length === 0 ? (
            <p className="text-muted-foreground p-4 font-sans text-sm">
              {filterParams
                ? 'No lines match these filters.'
                : 'No log lines yet. Ask a question or upload a document and they will appear here.'}
            </p>
          ) : (
            <ul className="divide-border/60 divide-y">
              {lines.map((line) => (
                <LogRow
                  key={line.id}
                  line={line}
                  onRequest={(id) => {
                    setRequestId(id)
                    setLive(true)
                  }}
                />
              ))}
            </ul>
          )}
        </div>
        {!follow && lines.length > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="bg-foreground text-background absolute right-4 bottom-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-lg"
          >
            <ArrowDown className="size-3.5" /> Latest
          </button>
        )}
      </div>

      <p
        className="text-muted-foreground flex flex-wrap gap-x-3 text-xs"
        role="status"
      >
        <span>{lines.length.toLocaleString()} lines shown</span>
        <span>{live ? 'Updating every 2 seconds' : 'Paused'}</span>
        {error && <span className="text-destructive">{error}</span>}
      </p>
    </div>
  )
}
