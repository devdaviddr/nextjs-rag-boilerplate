import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ScrollText } from 'lucide-react'

import {
  duration,
  runStatus,
  termination,
  when,
} from '@/components/observability/format'
import { RunTrace } from '@/components/observability/run-trace'
import { getRun } from '@/lib/observability/queries'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Run · Observability' }

/** One run, step by step (spec 0042 FR9). The layout has checked the role. */
export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const found = await getRun(id)
  if (!found) notFound()
  const { run, steps } = found
  const s = runStatus(run.status)

  const facts: [string, string][] = [
    ['Took', duration(run.durationMs)],
    ...(run.kind === 'question'
      ? ([
          ['First word', duration(run.ttftMs)],
          ['How', run.mode ?? '–'],
          ['Ended because', termination(run.termination)],
          ['Sources', String(run.sourceCount ?? 0)],
          [
            'Best match',
            run.bestSimilarity !== null ? run.bestSimilarity.toFixed(2) : '–',
          ],
        ] as [string, string][])
      : ([['Passages', String(run.sourceCount ?? 0)]] as [string, string][])),
    ['Tokens', run.totalTokens ? run.totalTokens.toLocaleString() : '–'],
  ]

  return (
    <div className="-mx-1 min-h-0 flex-1 space-y-5 overflow-y-auto px-1 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/observability/runs"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> All runs
        </Link>
        <Link
          href={`/observability/logs?requestId=${run.id}`}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm"
        >
          <ScrollText className="size-4" /> Log lines for this run
        </Link>
      </div>

      <header className="space-y-2">
        <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cn('rounded px-1.5 py-0.5 font-medium', s.className)}
            title={s.help}
          >
            {s.label}
          </span>
          {run.kind === 'ingest' ? 'Document ingestion' : 'Question'} ·{' '}
          {when(run.startedAt)}
        </p>
        <h2 className="text-xl font-semibold">{run.question ?? '(no text)'}</h2>
        {run.error && (
          <p className="rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-300">
            {run.error}
          </p>
        )}
      </header>

      <dl className="bg-border grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-px overflow-hidden rounded-lg border">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-background p-3">
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="mt-1 truncate text-sm font-semibold first-letter:uppercase">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {run.models.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Models:{' '}
          {run.models.map((m, i) => (
            <span key={m}>
              {i > 0 && ', '}
              <span className="text-foreground font-mono">{m}</span>
            </span>
          ))}
        </p>
      )}

      {steps.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          This run recorded no steps.
        </p>
      ) : (
        <RunTrace
          steps={steps}
          startedAt={run.startedAt}
          totalMs={run.durationMs}
        />
      )}
    </div>
  )
}
