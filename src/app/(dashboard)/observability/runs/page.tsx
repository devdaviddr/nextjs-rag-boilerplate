import type { Metadata } from 'next'
import Link from 'next/link'
import { FileText, MessageSquare } from 'lucide-react'

import {
  duration,
  runStatus,
  termination,
  when,
} from '@/components/observability/format'
import { listRuns } from '@/lib/observability/queries'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Runs · Observability' }

const KINDS = [
  { value: undefined, label: 'All' },
  { value: 'question', label: 'Questions' },
  { value: 'ingest', label: 'Ingestions' },
] as const

const STATUSES = [
  { value: undefined, label: 'Any outcome' },
  { value: 'ok', label: 'Answered' },
  { value: 'refused', label: 'No match' },
  { value: 'error', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
] as const

/** Observability → Runs (spec 0042 FR9): every question and ingestion. */
export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string; q?: string }>
}) {
  const params = await searchParams
  const kind =
    params.kind === 'question' || params.kind === 'ingest'
      ? params.kind
      : undefined
  const status = STATUSES.some((s) => s.value === params.status)
    ? params.status
    : undefined
  const q = params.q?.trim().slice(0, 200) || undefined
  const runs = await listRuns({ kind, status, q })

  const href = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams()
    const merged = { kind, status, q, ...next }
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v)
    const s = p.toString()
    return s ? `/observability/runs?${s}` : '/observability/runs'
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 pb-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <nav aria-label="Kind" className="flex gap-1">
          {KINDS.map((k) => (
            <Link
              key={k.label}
              href={href({ kind: k.value })}
              aria-current={kind === k.value ? 'true' : undefined}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs',
                kind === k.value
                  ? 'border-foreground bg-background font-medium'
                  : 'text-muted-foreground',
              )}
            >
              {k.label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Outcome" className="flex flex-wrap gap-1">
          {STATUSES.map((s) => (
            <Link
              key={s.label}
              href={href({ status: s.value })}
              aria-current={status === s.value ? 'true' : undefined}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs',
                status === s.value
                  ? 'border-foreground bg-background font-medium'
                  : 'text-muted-foreground',
              )}
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <form action="/observability/runs" className="ml-auto w-full sm:w-64">
          {kind && <input type="hidden" name="kind" value={kind} />}
          {status && <input type="hidden" name="status" value={status} />}
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search questions"
            aria-label="Search runs"
            className="border-input bg-background focus-visible:ring-ring/50 h-8 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-[3px]"
          />
        </form>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        {runs.length === 0 ? (
          <p className="text-muted-foreground p-6 text-sm">
            No runs yet. Ask a question or upload a document, and it will show
            up here with every step it took.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground sticky top-0 text-left text-xs">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">What</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">
                  How
                </th>
                <th className="px-3 py-2 text-right font-medium">Took</th>
                <th className="hidden px-3 py-2 text-right font-medium lg:table-cell">
                  First word
                </th>
                <th className="hidden px-3 py-2 text-right font-medium lg:table-cell">
                  Tokens
                </th>
                <th className="hidden px-3 py-2 text-right font-medium xl:table-cell">
                  Best match
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {runs.map((run) => {
                const s = runStatus(run.status)
                const Icon = run.kind === 'ingest' ? FileText : MessageSquare
                return (
                  <tr key={run.id} className="hover:bg-muted/40">
                    <td className="text-muted-foreground px-3 py-2 whitespace-nowrap tabular-nums">
                      {when(run.startedAt)}
                    </td>
                    <td className="max-w-[28rem] px-3 py-2">
                      <Link
                        href={`/observability/runs/${run.id}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <Icon
                          className="text-muted-foreground size-4 shrink-0"
                          aria-label={
                            run.kind === 'ingest' ? 'Ingestion' : 'Question'
                          }
                        />
                        <span className="truncate">
                          {run.question ?? '(no text)'}
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
                          s.className,
                        )}
                        title={s.help}
                      >
                        {s.label}
                      </span>
                    </td>
                    <td className="text-muted-foreground hidden px-3 py-2 text-xs md:table-cell">
                      {run.kind === 'ingest'
                        ? `${run.sourceCount ?? 0} passages`
                        : `${run.mode ?? '–'}${run.termination ? ` · ${termination(run.termination)}` : ''}`}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                      {duration(run.durationMs)}
                    </td>
                    <td className="hidden px-3 py-2 text-right tabular-nums lg:table-cell">
                      {duration(run.ttftMs)}
                    </td>
                    <td className="hidden px-3 py-2 text-right tabular-nums lg:table-cell">
                      {run.totalTokens ? run.totalTokens.toLocaleString() : '–'}
                    </td>
                    <td className="hidden px-3 py-2 text-right tabular-nums xl:table-cell">
                      {run.bestSimilarity !== null
                        ? run.bestSimilarity.toFixed(2)
                        : '–'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
