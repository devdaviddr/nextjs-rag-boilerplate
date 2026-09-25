import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/db'

/**
 * The numbers behind Observability → Overview (spec 0042 FR10). Every
 * aggregate is computed in SQL over `rag_runs` / `rag_spans` (NFR4), for the
 * chosen window and the one before it, so each tile can say which way it
 * moved.
 */

export type Range = '24h' | '7d'

export const RANGES: Record<
  Range,
  { ms: number; buckets: number; label: string }
> = {
  '24h': { ms: 24 * 60 * 60 * 1_000, buckets: 24, label: 'Last 24 hours' },
  '7d': { ms: 7 * 24 * 60 * 60 * 1_000, buckets: 28, label: 'Last 7 days' },
}

export interface Kpis {
  questions: number
  refusalRate: number | null
  errorRate: number | null
  p50Ms: number | null
  p95Ms: number | null
  ttftP50Ms: number | null
  tokensPerAnswer: number | null
}

export interface Bucket {
  start: string
  answered: number
  refused: number
  failed: number
  p50Ms: number | null
  p95Ms: number | null
  ttftP50Ms: number | null
  tokens: number | null
}

export interface Telemetry {
  range: Range
  from: string
  to: string
  kpis: Kpis
  previous: Kpis
  buckets: Bucket[]
  terminations: { name: string; count: number }[]
  modes: { name: string; count: number }[]
  similarity: { bin: number; count: number }[]
  steps: {
    name: string
    count: number
    avgMs: number
    p95Ms: number
    errors: number
  }[]
  failuresByModel: {
    model: string
    step: string
    count: number
    lastError: string | null
  }[]
  ingestion: {
    documents: number
    failed: number
    passages: number
    p50Ms: number | null
  }
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)

async function kpis(from: Date, to: Date): Promise<Kpis> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT
      count(*) FILTER (WHERE kind = 'question') AS questions,
      count(*) FILTER (WHERE kind = 'question' AND status = 'refused') AS refused,
      count(*) FILTER (WHERE status = 'error') AS errors,
      count(*) AS runs,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
        FILTER (WHERE kind = 'question' AND status = 'ok') AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
        FILTER (WHERE kind = 'question' AND status = 'ok') AS p95,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms)
        FILTER (WHERE kind = 'question' AND ttft_ms IS NOT NULL) AS ttft,
      avg(total_tokens) FILTER (WHERE kind = 'question' AND status = 'ok') AS tokens
    FROM rag_runs
    WHERE started_at >= ${from.toISOString()} AND started_at < ${to.toISOString()}
  `)
  const r = rows[0] ?? {}
  const questions = Number(r.questions ?? 0)
  const runs = Number(r.runs ?? 0)
  return {
    questions,
    refusalRate: questions ? Number(r.refused) / questions : null,
    errorRate: runs ? Number(r.errors) / runs : null,
    p50Ms: num(r.p50),
    p95Ms: num(r.p95),
    ttftP50Ms: num(r.ttft),
    tokensPerAnswer: num(r.tokens),
  }
}

export async function telemetry(
  range: Range,
  now = new Date(),
): Promise<Telemetry> {
  const { ms, buckets: bucketCount } = RANGES[range]
  const to = now
  const from = new Date(to.getTime() - ms)
  const prevFrom = new Date(from.getTime() - ms)
  const bucketMs = ms / bucketCount
  const bucketSeconds = bucketMs / 1_000

  const [
    current,
    previous,
    bucketRows,
    terminationRows,
    modeRows,
    similarityRows,
    stepRows,
    failureRows,
    ingestRows,
  ] = await Promise.all([
    kpis(from, to),
    kpis(prevFrom, from),
    db.execute<Record<string, unknown>>(sql`
      SELECT
        floor(extract(epoch FROM started_at - ${from.toISOString()}::timestamptz) / ${bucketSeconds})::int AS i,
        count(*) FILTER (WHERE status = 'ok') AS answered,
        count(*) FILTER (WHERE status = 'refused') AS refused,
        count(*) FILTER (WHERE status IN ('error', 'cancelled')) AS failed,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status = 'ok') AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status = 'ok') AS p95,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms) FILTER (WHERE ttft_ms IS NOT NULL) AS ttft,
        avg(total_tokens) FILTER (WHERE status = 'ok') AS tokens
      FROM rag_runs
      WHERE kind = 'question' AND started_at >= ${from.toISOString()} AND started_at < ${to.toISOString()}
      GROUP BY 1
    `),
    db.execute<Record<string, unknown>>(sql`
      SELECT coalesce(termination, 'none') AS name, count(*) AS count
      FROM rag_runs
      WHERE kind = 'question' AND mode = 'agentic'
        AND started_at >= ${from.toISOString()} AND started_at < ${to.toISOString()}
      GROUP BY 1 ORDER BY 2 DESC
    `),
    db.execute<Record<string, unknown>>(sql`
      SELECT coalesce(mode, 'none') AS name, count(*) AS count
      FROM rag_runs
      WHERE kind = 'question' AND started_at >= ${from.toISOString()} AND started_at < ${to.toISOString()}
      GROUP BY 1 ORDER BY 2 DESC
    `),
    db.execute<Record<string, unknown>>(sql`
      SELECT least(floor(best_similarity * 20), 19)::int AS bin, count(*) AS count
      FROM rag_runs
      WHERE kind = 'question' AND best_similarity IS NOT NULL
        AND started_at >= ${from.toISOString()} AND started_at < ${to.toISOString()}
      GROUP BY 1 ORDER BY 1
    `),
    db.execute<Record<string, unknown>>(sql`
      SELECT s.name,
        count(*) AS count,
        avg(s.duration_ms) AS avg_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms) AS p95_ms,
        count(*) FILTER (WHERE s.status = 'error') AS errors
      FROM rag_spans s JOIN rag_runs r ON r.id = s.run_id
      WHERE r.started_at >= ${from.toISOString()} AND r.started_at < ${to.toISOString()}
      GROUP BY s.name ORDER BY avg(s.duration_ms) DESC
    `),
    db.execute<Record<string, unknown>>(sql`
      SELECT coalesce(s.model, '(none)') AS model, s.name AS step, count(*) AS count,
        (array_agg(s.attributes->>'error' ORDER BY s.started_at DESC))[1] AS last_error
      FROM rag_spans s JOIN rag_runs r ON r.id = s.run_id
      WHERE s.status = 'error' AND r.started_at >= ${from.toISOString()} AND r.started_at < ${to.toISOString()}
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10
    `),
    db.execute<Record<string, unknown>>(sql`
      SELECT
        count(*) FILTER (WHERE status = 'ok') AS documents,
        count(*) FILTER (WHERE status = 'error') AS failed,
        coalesce(sum(source_count) FILTER (WHERE status = 'ok'), 0) AS passages,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status = 'ok') AS p50
      FROM rag_runs
      WHERE kind = 'ingest' AND started_at >= ${from.toISOString()} AND started_at < ${to.toISOString()}
    `),
  ])

  const byIndex = new Map(bucketRows.map((r) => [Number(r.i), r]))
  const buckets: Bucket[] = Array.from({ length: bucketCount }, (_, i) => {
    const r = byIndex.get(i)
    return {
      start: new Date(from.getTime() + i * bucketMs).toISOString(),
      answered: Number(r?.answered ?? 0),
      refused: Number(r?.refused ?? 0),
      failed: Number(r?.failed ?? 0),
      p50Ms: num(r?.p50),
      p95Ms: num(r?.p95),
      ttftP50Ms: num(r?.ttft),
      tokens: num(r?.tokens),
    }
  })

  const binCounts = new Map(
    similarityRows.map((r) => [Number(r.bin), Number(r.count)]),
  )
  const ingest = ingestRows[0] ?? {}

  return {
    range,
    from: from.toISOString(),
    to: to.toISOString(),
    kpis: current,
    previous,
    buckets,
    terminations: terminationRows.map((r) => ({
      name: String(r.name),
      count: Number(r.count),
    })),
    modes: modeRows.map((r) => ({
      name: String(r.name),
      count: Number(r.count),
    })),
    similarity: Array.from({ length: 20 }, (_, bin) => ({
      bin,
      count: binCounts.get(bin) ?? 0,
    })),
    steps: stepRows.map((r) => ({
      name: String(r.name),
      count: Number(r.count),
      avgMs: Math.round(Number(r.avg_ms)),
      p95Ms: Math.round(Number(r.p95_ms)),
      errors: Number(r.errors),
    })),
    failuresByModel: failureRows.map((r) => ({
      model: String(r.model),
      step: String(r.step),
      count: Number(r.count),
      lastError: r.last_error === null ? null : String(r.last_error),
    })),
    ingestion: {
      documents: Number(ingest.documents ?? 0),
      failed: Number(ingest.failed ?? 0),
      passages: Number(ingest.passages ?? 0),
      p50Ms: num(ingest.p50),
    },
  }
}
