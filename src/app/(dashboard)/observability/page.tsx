import type { Metadata } from 'next'
import Link from 'next/link'

import {
  LatencyChart,
  QuestionsChart,
  SimilarityChart,
} from '@/components/observability/charts'
import {
  STEP_LABEL,
  duration,
  runStatus,
  termination,
  when,
} from '@/components/observability/format'
import { PartitionBar } from '@/components/observability/partition-bar'
import { StatTile } from '@/components/observability/stat-tile'
import { InfoTip } from '@/components/ui/info-tip'
import { aiSettings, refreshAiSettings } from '@/lib/ai-settings'
import { listRuns } from '@/lib/observability/queries'
import { RANGES, type Range, telemetry } from '@/lib/observability/telemetry'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Overview · Observability' }

const pctText = (v: number | null) =>
  v === null ? '–' : `${(v * 100).toFixed(v < 0.1 && v > 0 ? 1 : 0)}%`

const TERMINATION_COLOUR: Record<string, string> = {
  'planner-answered': 'bg-emerald-500',
  'planner-refused': 'bg-amber-500',
  'repeated-query': 'bg-amber-500',
  'search-budget': 'bg-orange-500',
  'time-budget': 'bg-red-400',
  'token-budget': 'bg-rose-500',
  'planner-unavailable': 'bg-red-600',
  'whole-document': 'bg-teal-500',
  confident: 'bg-emerald-400',
  'planner-slow': 'bg-amber-600',
}

const MODE = {
  search: { name: 'Search', className: 'bg-teal-500' },
  document: { name: 'Whole document', className: 'bg-sky-500' },
  agentic: { name: 'Agentic', className: 'bg-orange-500' },
} as Record<string, { name: string; className: string }>

function Panel({
  title,
  help,
  children,
  className,
}: {
  title: string
  help?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      aria-label={title}
      className={cn('bg-background rounded-lg border p-4', className)}
    >
      <h2 className="mb-3 flex items-center gap-1 text-sm font-medium">
        {title}
        {help && (
          <InfoTip title={title}>
            <p>{help}</p>
          </InfoTip>
        )}
      </h2>
      {children}
    </section>
  )
}

/** Observability → Overview (spec 0042 FR10). The layout has checked the role. */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>
}) {
  const { range: raw } = await searchParams
  const range: Range = raw === '7d' ? '7d' : '24h'
  await refreshAiSettings()
  const floor = aiSettings().RAG_MIN_SIMILARITY
  const [t, recent] = await Promise.all([telemetry(range), listRuns({}, 6)])
  const { kpis, previous, buckets } = t
  const series = <K extends keyof (typeof buckets)[number]>(k: K) =>
    buckets.map((b) => b[k] as number | null)
  const questionSeries = buckets.map((b) => b.answered + b.refused + b.failed)
  const empty = kpis.questions === 0 && t.ingestion.documents === 0

  return (
    <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {RANGES[range].label}, compared with the{' '}
          {range === '24h' ? 'day' : 'week'} before.
        </p>
        <nav aria-label="Time range" className="flex gap-1">
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <Link
              key={r}
              href={
                r === '24h' ? '/observability' : `/observability?range=${r}`
              }
              aria-current={range === r ? 'true' : undefined}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs',
                range === r
                  ? 'border-foreground font-medium'
                  : 'text-muted-foreground',
              )}
            >
              {RANGES[r].label}
            </Link>
          ))}
        </nav>
      </div>

      {empty && (
        <p className="bg-muted/40 rounded-lg p-4 text-sm">
          Nothing recorded in this window yet. Ask a question or upload a
          document, and it shows up here.
        </p>
      )}

      <div className="bg-border grid grid-cols-2 gap-px overflow-hidden rounded-lg border md:grid-cols-3 2xl:grid-cols-6">
        <StatTile
          label="Questions"
          value={kpis.questions.toLocaleString()}
          current={kpis.questions}
          previous={previous.questions}
          better="up"
          series={questionSeries}
          help="Questions asked in this window, whatever their outcome."
        />
        <StatTile
          label="No match"
          value={pctText(kpis.refusalRate)}
          current={kpis.refusalRate}
          previous={previous.refusalRate}
          better="down"
          series={buckets.map((b) => {
            const n = b.answered + b.refused + b.failed
            return n ? b.refused / n : null
          })}
          help="How often nothing in the documents was close enough, so the app said so instead of answering. Rising can mean people ask about things that are not uploaded, or the floor is set too high."
        />
        <StatTile
          label="Answer time (median)"
          value={duration(kpis.p50Ms)}
          current={kpis.p50Ms}
          previous={previous.p50Ms}
          better="down"
          series={series('p50Ms')}
          help={`Half of answers took less than this, from question to the end of the answer. The slowest 5% took ${duration(kpis.p95Ms)} or more.`}
        />
        <StatTile
          label="First word (median)"
          value={duration(kpis.ttftP50Ms)}
          current={kpis.ttftP50Ms}
          previous={previous.ttftP50Ms}
          better="down"
          series={series('ttftP50Ms')}
          help="How long people wait before the answer starts to appear. Searching and planning happen before this, so agentic mode makes it longer."
        />
        <StatTile
          label="Tokens per answer"
          value={
            kpis.tokensPerAnswer === null
              ? '–'
              : Math.round(kpis.tokensPerAnswer).toLocaleString()
          }
          current={kpis.tokensPerAnswer}
          previous={previous.tokensPerAnswer}
          better="down"
          series={series('tokens')}
          help="Tokens used per answered question, across every model it called: planner, answer, citation check. It is what a paid provider charges for."
        />
        <StatTile
          label="Failed"
          value={pctText(kpis.errorRate)}
          current={kpis.errorRate}
          previous={previous.errorRate}
          better="down"
          series={buckets.map((b) => {
            const n = b.answered + b.refused + b.failed
            return n ? b.failed / n : null
          })}
          help="Questions and ingestions that ended in an error, usually the model provider being down or overloaded. Runs lists them."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <QuestionsChart buckets={buckets} range={range} />
        <LatencyChart buckets={buckets} range={range} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="How questions were searched"
          help="Search is one hybrid search. Whole document reads a whole file, for summaries. Agentic lets the planner search several times."
        >
          <PartitionBar
            label="Retrieval modes"
            segments={t.modes.map((m) => ({
              name: MODE[m.name]?.name ?? m.name,
              count: m.count,
              className: MODE[m.name]?.className ?? 'bg-slate-400',
            }))}
          />
        </Panel>
        <Panel
          title="How agentic searches ended"
          help="Why the planner stopped searching. Planner had enough is the healthy case. Time or token budget means it was cut off; planner unavailable means the planner model failed and the app fell back to one plain search."
        >
          <PartitionBar
            label="Agentic endings"
            segments={t.terminations.map((x) => ({
              name: termination(x.name),
              count: x.count,
              className: TERMINATION_COLOUR[x.name] ?? 'bg-slate-400',
            }))}
          />
        </Panel>
        <Panel
          title="Documents processed"
          help="Uploads turned into searchable passages in this window."
        >
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">Ingested</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {t.ingestion.documents}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Failed</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {t.ingestion.failed}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Passages made</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {t.ingestion.passages.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Typical time</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {duration(t.ingestion.p50Ms)}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SimilarityChart bins={t.similarity} floor={floor} />
        <Panel
          title="Where the time goes"
          help="Average time of each step across all runs, longest first, with how often it failed. The bar is the average; the figure after it is the slowest 5%."
        >
          {t.steps.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {t.steps.map((s) => {
                const max = t.steps[0]!.avgMs || 1
                return (
                  <li
                    key={s.name}
                    className="grid grid-cols-[9rem_1fr_auto] items-center gap-3"
                  >
                    <span className="truncate">
                      {STEP_LABEL[s.name] ?? s.name}
                    </span>
                    <span className="bg-muted h-2 overflow-hidden rounded-full">
                      <span
                        className="block h-full rounded-full bg-orange-500"
                        style={{ width: `${(s.avgMs / max) * 100}%` }}
                      />
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {duration(s.avgMs)} · p95 {duration(s.p95Ms)}
                      {s.errors > 0 && (
                        <span className="text-red-700 dark:text-red-400">
                          {' '}
                          · {s.errors} failed
                        </span>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Failures by model"
          help="Steps that failed, grouped by the model they used and the step. (none) means the step failed before a model answered, such as a timeout."
        >
          {t.failuresByModel.length === 0 ? (
            <p className="text-muted-foreground text-sm">No failures. 🎉</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs">
                <tr>
                  <th className="pb-1 font-medium">Model</th>
                  <th className="pb-1 font-medium">Step</th>
                  <th className="pb-1 text-right font-medium">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {t.failuresByModel.map((f) => (
                  <tr
                    key={`${f.model}:${f.step}`}
                    title={f.lastError ?? undefined}
                  >
                    <td className="max-w-[14rem] truncate py-1.5 font-mono text-xs">
                      {f.model}
                    </td>
                    <td className="py-1.5">{STEP_LABEL[f.step] ?? f.step}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {f.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Latest runs">
          {recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {recent.map((r) => {
                const s = runStatus(r.status)
                return (
                  <li key={r.id} className="flex items-center gap-2 py-1.5">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium',
                        s.className,
                      )}
                    >
                      {s.label}
                    </span>
                    <Link
                      href={`/observability/runs/${r.id}`}
                      className="min-w-0 flex-1 truncate hover:underline"
                    >
                      {r.question ?? '(no text)'}
                    </Link>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {duration(r.durationMs)} · {when(r.startedAt)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <Link
            href="/observability/runs"
            className="text-muted-foreground hover:text-foreground mt-2 inline-block text-xs underline-offset-2 hover:underline"
          >
            All runs →
          </Link>
        </Panel>
      </div>
    </div>
  )
}
