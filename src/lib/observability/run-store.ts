import 'server-only'

import { lt } from 'drizzle-orm'

import { redact } from './redact'
import { type RunRecord, setRunWriter } from './runs'

/**
 * Stores finished runs (spec 0042 FR8) and prunes them after
 * `TELEMETRY_RETENTION_DAYS`. Full question and passage text is kept
 * (decision 2); only secrets are removed.
 */

async function writeRun(run: RunRecord): Promise<void> {
  const [{ db }, { ragRuns, ragSpans }] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
  ])
  await db.transaction(async (tx) => {
    await tx
      .insert(ragRuns)
      .values({
        id: run.id,
        kind: run.kind,
        userId: run.userId ?? null,
        conversationId: run.conversationId ?? null,
        documentId: run.documentId ?? null,
        question: run.question ?? null,
        mode: run.mode ?? null,
        status: run.status,
        termination: run.termination ?? null,
        startedAt: run.startedAt,
        durationMs: run.durationMs,
        ttftMs: run.ttftMs ?? null,
        promptTokens: run.promptTokens ?? null,
        completionTokens: run.completionTokens ?? null,
        totalTokens: run.totalTokens,
        bestSimilarity: run.bestSimilarity ?? null,
        sourceCount: run.sourceCount ?? null,
        models: run.models,
        error: run.error ?? null,
      })
      .onConflictDoNothing()
    if (run.spans.length > 0) {
      await tx.insert(ragSpans).values(
        run.spans.map((s) => ({
          runId: run.id,
          key: s.key,
          parentKey: s.parentKey,
          name: s.name,
          startedAt: s.startedAt,
          durationMs: s.durationMs,
          status: s.status,
          model: s.model,
          tokens: s.tokens,
          attributes: redact(s.attributes) as Record<string, unknown>,
        })),
      )
    }
  })
}

async function prune(retentionDays: number): Promise<void> {
  const [{ db }, { ragRuns }] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
  ])
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1_000)
  await db.delete(ragRuns).where(lt(ragRuns.startedAt, cutoff))
}

const state = globalThis as { __appRunStoreStarted?: boolean }

/** Called once per server process from `instrumentation.ts`. */
export function startRunStore({ retentionDays }: { retentionDays: number }) {
  if (state.__appRunStoreStarted) return
  state.__appRunStoreStarted = true
  setRunWriter(writeRun)
  const runPrune = () =>
    prune(retentionDays).catch((err: unknown) =>
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'runs: pruning old runs failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    )
  setTimeout(runPrune, 45_000).unref()
  setInterval(runPrune, 60 * 60 * 1_000).unref()
}
