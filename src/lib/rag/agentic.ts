/**
 * The bounded agentic retrieval loop (spec 0029 FR5).
 *
 * The model decides what to search for and whether what came back is enough.
 * This module decides when to stop. Those are deliberately different jobs: an
 * unbounded loop against a rate-limited free tier is a denial-of-service
 * against yourself, and "stop when you think you're done" is not a bound.
 *
 * ## Refusal is not in here
 *
 * This loop gathers evidence. It never composes prose and it never decides to
 * refuse — it returns what it found and why it stopped, and the CALLER
 * short-circuits to a fixed refusal when nothing cleared the floor. That keeps
 * refusal a code path around the loop rather than something the model is asked
 * to honour, which is the guarantee the whole system rests on (spec 0029 NFR1).
 *
 * A model that is talked into ignoring its instructions still cannot produce an
 * ungrounded answer, because with no retrieved context there is no drafting
 * call for it to hijack.
 */

import type { PlannerDecision } from './planner'
import type { RetrievedChunk } from './retrieve'

export interface LoopBudget {
  /** Hard cap on `search_documents` calls. */
  maxSearches: number
  /** Wall-clock for the whole loop, excluding answer streaming. */
  maxMs: number
  /** Prompt + completion tokens across every planning call. */
  maxTokens: number
}

/** Why the loop stopped. Every value is reported in the trace, not swallowed. */
export type LoopTermination =
  | 'planner-answered'
  | 'planner-refused'
  | 'search-budget'
  | 'time-budget'
  | 'token-budget'
  | 'planner-unavailable'

export interface LoopStep {
  iteration: number
  query: string
  documentId?: string
  resultCount: number
  bestSimilarity: number | null
  /**
   * A short summary of what the search actually returned.
   *
   * Given only counts and scores, the planner cannot judge whether it has
   * enough to answer, so it kept searching until the budget ran out even when
   * the first search had already found the answer. It needs to see the
   * passages, not statistics about them.
   */
  found?: string
  elapsedMs: number
}

export interface LoopOutcome {
  /** Everything retrieved, deduplicated, best-scoring first. */
  chunks: RetrievedChunk[]
  termination: LoopTermination
  steps: LoopStep[]
  searches: number
  tokensUsed: number
  elapsedMs: number
}

export interface PlanResult {
  decision: PlannerDecision | null
  /** Total tokens the planning call consumed, from the provider's usage frame. */
  tokens: number
}

export interface LoopDeps {
  /**
   * Ask the planner what to do next. `history` is the running record of what
   * has already been searched and what came back, so the model can tell a
   * second attempt from a first.
   */
  plan: (
    history: readonly LoopStep[],
    signal: AbortSignal,
  ) => Promise<PlanResult>
  /**
   * Run one search. Owner and permitted knowledge bases are bound by the
   * CALLER, not passed in here — the loop has no way to widen its own scope
   * even if the planner asks it to (spec 0028 boundary).
   */
  search: (query: string, documentId?: string) => Promise<RetrievedChunk[]>
  /**
   * Called when a planning attempt fails or returns nothing usable.
   *
   * The loop treats both as "stop", which is correct — retrying a planner that
   * just emitted nothing usable is how a bounded loop becomes unbounded. But
   * swallowing the REASON made a genuine upstream failure indistinguishable
   * from a deliberate decision in the logs. It must be reportable.
   */
  onPlanFailure?: (reason: string, error?: unknown) => void
  /**
   * Query to search with if the planner tries to answer before it has searched
   * even once. Normally the user's question.
   *
   * The router has ALREADY decided this turn needs retrieval — that decision is
   * deliberately biased towards searching, because the alternative is an
   * ungrounded answer. Letting the planner then skip the search re-opens
   * exactly that hole one layer down, and it happens in practice: measured on
   * a live endpoint, several questions came back `planner-answered` with zero
   * searches and zero chunks, which the caller can only turn into a refusal.
   *
   * So the first pass always retrieves something. The planner may decide it has
   * enough from the second call onwards, when there is evidence to judge.
   */
  fallbackQuery?: string
  /** Injected for deterministic tests. */
  now?: () => number
}

/**
 * The similarity floor for evidence gathered over `searches` attempts.
 *
 * One search is judged at the base floor, exactly as the fixed pipeline judges
 * it. Each additional attempt raises the bar, because each additional attempt
 * is another chance to clear it by luck rather than by relevance — the same
 * reason you tighten a threshold when you take more samples.
 *
 * Measured: without this, three searches for an unanswerable question surfaced
 * a chunk at 0.421 and refusal accuracy fell from 1.000 to 0.667.
 */
export function effectiveFloor(
  baseFloor: number,
  searches: number,
  step: number,
): number {
  return baseFloor + step * Math.max(0, searches - 1)
}

/**
 * Merge new results into the accumulator, keeping the best score per chunk.
 *
 * Two searches routinely return overlapping passages. Without dedup the same
 * chunk would be cited twice and would crowd out a distinct one.
 */
export function accumulate(
  existing: readonly RetrievedChunk[],
  incoming: readonly RetrievedChunk[],
): RetrievedChunk[] {
  const byId = new Map<string, RetrievedChunk>()
  for (const chunk of [...existing, ...incoming]) {
    const seen = byId.get(chunk.chunkId)
    if (!seen || chunk.similarity > seen.similarity)
      byId.set(chunk.chunkId, chunk)
  }
  return [...byId.values()].sort((a, b) => b.similarity - a.similarity)
}

export async function runAgenticLoop(
  budget: LoopBudget,
  deps: LoopDeps,
  signal: AbortSignal,
): Promise<LoopOutcome> {
  const now = deps.now ?? (() => Date.now())
  const startedAt = now()

  let chunks: RetrievedChunk[] = []
  const steps: LoopStep[] = []
  let tokensUsed = 0
  let searches = 0

  const elapsed = () => now() - startedAt
  const finish = (termination: LoopTermination): LoopOutcome => ({
    chunks,
    termination,
    steps,
    searches,
    tokensUsed,
    elapsedMs: elapsed(),
  })

  for (;;) {
    // Budgets are checked BEFORE the expensive call, never after. Checking
    // afterwards would let each bound be exceeded by exactly one call.
    if (searches >= budget.maxSearches) return finish('search-budget')
    if (elapsed() >= budget.maxMs) return finish('time-budget')
    if (tokensUsed >= budget.maxTokens) return finish('token-budget')

    let result: PlanResult
    try {
      result = await deps.plan(steps, signal)
    } catch (error) {
      // The planner failing is not the request failing. Whatever was gathered
      // so far still stands, and the caller decides whether it is enough.
      deps.onPlanFailure?.('planner call threw', error)
      return finish('planner-unavailable')
    }
    tokensUsed += result.tokens

    let decision = result.decision
    // A null decision means the response carried no usable instruction. Treated
    // as "stop", not "retry": retrying a planner that just emitted nothing
    // usable is how a bounded loop quietly becomes an unbounded one.
    if (!decision) {
      deps.onPlanFailure?.('no usable decision in the response')
      return finish('planner-unavailable')
    }
    if (decision.action === 'answer') {
      // Answering before any evidence exists is not a decision the planner is
      // allowed to make — see `fallbackQuery`.
      if (searches === 0 && chunks.length === 0 && deps.fallbackQuery) {
        deps.onPlanFailure?.(
          'planner answered before searching; forcing one search',
        )
        decision = { action: 'search', query: deps.fallbackQuery }
      } else {
        return finish('planner-answered')
      }
    }
    if (decision.action === 'refuse') return finish('planner-refused')

    const query = decision.query?.trim()
    if (!query) {
      deps.onPlanFailure?.('search decision carried no query')
      return finish('planner-unavailable')
    }

    searches += 1
    const found = await deps.search(query, decision.documentId)
    chunks = accumulate(chunks, found)

    steps.push({
      iteration: searches,
      query,
      documentId: decision.documentId,
      resultCount: found.length,
      bestSimilarity: found.length
        ? Math.max(...found.map((c) => c.similarity))
        : null,
      // Top few only, truncated. The planner needs enough to judge
      // sufficiency; the whole passage set would blow the token budget it is
      // simultaneously being measured against.
      found: found
        .slice(0, 3)
        .map(
          (c) =>
            `    [${c.documentTitle} p${c.pageNumber}] ${c.content.replace(/\s+/g, ' ').slice(0, 240)}`,
        )
        .join('\n'),
      elapsedMs: elapsed(),
    })
  }
}
