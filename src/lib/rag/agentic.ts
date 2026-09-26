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
   * Look at one figure and answer one question about it (spec 0031 FR9).
   *
   * Optional: when absent the tool is simply not offered, and a planner that
   * asks for it anyway is told there is nothing to look at. Scope is bound by
   * the CALLER exactly as `search` is — the model supplies a chunk id, which
   * is validated server-side, and nothing that decides what it may reach.
   *
   * Returns the reading as text, or null when the figure could not be read.
   */
  readFigure?: (
    chunkId: string,
    question: string,
    /** Carries whatever is left of the wall-clock budget. */
    signal: AbortSignal,
  ) => Promise<{
    text: string
    documentTitle: string
    pageNumber: number
    tokens: number
  } | null>
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
  /**
   * What to search when the planner is unavailable before the first search.
   * Defaults to `[fallbackQuery]`.
   *
   * Only the planner resolves references from the conversation, so on an
   * outage a follow-up like "what about Sweden Central?" searched on its own
   * finds nothing and is refused (#41). The caller can pass the literal
   * question PLUS a context-carrying variant; each is searched and the results
   * merged, and every chunk still has to clear the attempt-scaled floor, which
   * rises with each extra search. Bounded by the search budget.
   */
  outageQueries?: readonly string[]
  /**
   * The previous user question on its own, as a yardstick for the context
   * variants in `outageQueries` (#41). A chunk found ONLY by a context variant
   * is kept only if it is more similar to the variant than to this — i.e. the
   * new question made it more relevant. Otherwise it is the answer to the
   * previous question, and admitting it turns "And can it be extended?" into
   * a confident answer about probation length. Searched once, not counted as a
   * search (it is not evidence) and never added to the results.
   */
  outageBaseline?: string
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
 *
 * Parents (spec 0033, 1c) make "the same passage" wider than one id: a parent
 * CONTAINS its members, so one search's lone chunk and another search's
 * parent of it are the same evidence twice. So:
 *
 * - a parent absorbs any lone chunk whose id is among its `memberChunkIds`,
 *   whichever search found which first;
 * - the same parent from two searches is one entry;
 * - either way the survivor keeps the BEST similarity it was seen with. Every
 *   one of those scores is a real child cosine that cleared the gate, so the
 *   attempt-scaled floor applied after the loop SCORES the parent exactly as
 *   it would its best child — never worse, which is what keeps absorbing a
 *   chunk from ever losing it, and why refusal cannot move: the list is empty
 *   exactly when its best score is under the floor, parents or not.
 *
 * What the raised floor no longer bounds is the TEXT. A parent that passes on
 * its best child carries its whole run, including members whose own cosine is
 * under the raised floor and members no search admitted. That is the parent's
 * design at the base floor too (spec 0033 1c); under the agentic floor it
 * means the floor filters less text than it did before parents. Stated in the
 * spec's 1c amendment and pinned in rag-agentic.test.ts.
 */
export function accumulate(
  existing: readonly RetrievedChunk[],
  incoming: readonly RetrievedChunk[],
): RetrievedChunk[] {
  const all = [...existing, ...incoming]

  // Which parent (keyed by its own id) holds each member id.
  const parentOf = new Map<string, string>()
  for (const chunk of all) {
    if (!chunk.memberChunkIds?.length) continue
    for (const id of chunk.memberChunkIds) parentOf.set(id, chunk.chunkId)
  }

  // A parent's id is its run's FIRST chunk, which may also arrive as a lone
  // chunk — so parents and lone chunks are keyed apart.
  const keyOf = (chunk: RetrievedChunk): string =>
    chunk.memberChunkIds?.length
      ? `parent:${chunk.chunkId}`
      : parentOf.has(chunk.chunkId)
        ? `parent:${parentOf.get(chunk.chunkId)}`
        : `chunk:${chunk.chunkId}`

  const byKey = new Map<string, RetrievedChunk>()
  for (const chunk of all) {
    const key = keyOf(chunk)
    const seen = byKey.get(key)
    if (!seen) {
      byKey.set(key, chunk)
      continue
    }
    const seenIsParent = Boolean(seen.memberChunkIds?.length)
    const chunkIsParent = Boolean(chunk.memberChunkIds?.length)
    const similarity = Math.max(seen.similarity, chunk.similarity)
    if (chunkIsParent && !seenIsParent) {
      // A parent arriving after one of its members: the parent wins the slot.
      byKey.set(key, { ...chunk, similarity })
    } else if (seenIsParent && !chunkIsParent) {
      // A member arriving after its parent: dropped, its score kept.
      if (similarity > seen.similarity) byKey.set(key, { ...seen, similarity })
    } else if (chunk.similarity > seen.similarity) {
      byKey.set(key, chunk)
    }
  }
  return [...byKey.values()].sort((a, b) => b.similarity - a.similarity)
}

/** Why the loop's clock aborts a call it started (see `callSignal`). */
const BUDGET_EXHAUSTED = 'Loop time budget exhausted'

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

  /**
   * A signal for ONE call, bounded by whatever is left of the wall-clock
   * budget.
   *
   * Without this `maxMs` is a checkpoint, not a bound: it is read between
   * iterations, so a single slow call overruns it by however long that call
   * takes. Measured 2026-09-10 with a 45s budget — a figure question finished
   * at 102s, because the budget had no way to interrupt work already in
   * flight. Composing the remaining time into the call's own signal is what
   * turns the number into a promise.
   */
  const callSignal = (): { signal: AbortSignal; clear: () => void } => {
    const remaining = Math.max(0, budget.maxMs - elapsed())
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(BUDGET_EXHAUSTED)),
      remaining,
    )
    return {
      signal: AbortSignal.any([signal, controller.signal]),
      clear: () => clearTimeout(timer),
    }
  }
  const finish = (termination: LoopTermination): LoopOutcome => ({
    chunks,
    termination,
    steps,
    searches,
    tokensUsed,
    elapsedMs: elapsed(),
  })

  /**
   * Stop because the planner is unusable — but never with NO evidence.
   *
   * With the agentic path on by default, a planner that fails before its first
   * search (endpoint down, call timed out, nothing usable in the response) used
   * to end the loop with zero chunks, and zero chunks can only become a
   * refusal. Observed 2026-09-25: the planner model hung on every call, and
   * every question was refused after the 15s budget while the embedding and
   * chat models were healthy. So, as when the planner answers before
   * searching, the original question is searched once — the fixed path's
   * retrieval — and the answer is grounded in that instead.
   */
  const unavailable = async (): Promise<LoopOutcome> => {
    const queries = (
      deps.outageQueries?.length
        ? deps.outageQueries
        : deps.fallbackQuery
          ? [deps.fallbackQuery]
          : []
    )
      .map((q) => q.trim())
      .filter((q, i, all) => q.length > 0 && all.indexOf(q) === i)
      .slice(0, Math.max(1, budget.maxSearches))
    if (searches === 0 && chunks.length === 0 && queries.length > 0) {
      deps.onPlanFailure?.(
        `planner unavailable before searching; falling back to ${queries.length === 1 ? 'one search' : `${queries.length} searches`}`,
      )
      const literal = new Set<string>()
      let baseline: Map<string, number> | null = null
      for (const [i, query] of queries.entries()) {
        searches += 1
        let found = await deps.search(query, undefined)
        if (i === 0) {
          found.forEach((c) => literal.add(c.chunkId))
        } else if (deps.outageBaseline?.trim()) {
          baseline ??= new Map(
            (await deps.search(deps.outageBaseline.trim(), undefined)).map(
              (c) => [c.chunkId, c.similarity],
            ),
          )
          const yardstick = baseline
          found = found.filter(
            (c) =>
              literal.has(c.chunkId) ||
              c.similarity > (yardstick.get(c.chunkId) ?? -Infinity),
          )
        }
        chunks = accumulate(chunks, found)
        steps.push({
          iteration: searches,
          query,
          resultCount: found.length,
          bestSimilarity: found.length
            ? Math.max(...found.map((c) => c.similarity))
            : null,
          found: '',
          elapsedMs: elapsed(),
        })
      }
    }
    return finish('planner-unavailable')
  }

  for (;;) {
    // Budgets are checked BEFORE the expensive call, never after. Checking
    // afterwards would let each bound be exceeded by exactly one call.
    if (searches >= budget.maxSearches) return finish('search-budget')
    if (elapsed() >= budget.maxMs) return finish('time-budget')
    if (tokensUsed >= budget.maxTokens) return finish('token-budget')

    let result: PlanResult
    try {
      const call = callSignal()
      try {
        result = await deps.plan(steps, call.signal)
      } finally {
        call.clear()
      }
    } catch (error) {
      // The loop's own clock ending a call is not the planner failing (#83).
      // With a search already made, the evidence in hand stands and the loop
      // simply ran out of time: a budget stop like any other. Only before the
      // first search does it mean "no planner", which falls back to a search.
      const outOfTime =
        (error instanceof Error && error.message === BUDGET_EXHAUSTED) ||
        (!signal.aborted && elapsed() >= budget.maxMs)
      if (outOfTime && searches > 0) return finish('time-budget')
      // The planner failing is not the request failing. Whatever was gathered
      // so far still stands, and the caller decides whether it is enough.
      deps.onPlanFailure?.('planner call threw', error)
      return unavailable()
    }
    tokensUsed += result.tokens

    let decision = result.decision
    // A null decision means the response carried no usable instruction. Treated
    // as "stop", not "retry": retrying a planner that just emitted nothing
    // usable is how a bounded loop quietly becomes an unbounded one.
    if (!decision) {
      deps.onPlanFailure?.('no usable decision in the response')
      return unavailable()
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

    // Looking at a figure costs a step and a vision call, so it is bounded by
    // the SAME search budget rather than getting its own. Measured at ~4s for
    // a cropped region against a specific question — cheap next to a blind
    // description, expensive next to a text search, and either way it must not
    // be free to repeat.
    if (decision.action === 'read-figure') {
      const chunkId = decision.chunkId?.trim()
      const figureQuestion = decision.figureQuestion?.trim()
      if (!chunkId || !figureQuestion || !deps.readFigure) {
        deps.onPlanFailure?.('figure decision was not usable')
        return unavailable()
      }

      searches += 1
      const figureCall = callSignal()
      let reading
      try {
        reading = await deps.readFigure(
          chunkId,
          figureQuestion,
          figureCall.signal,
        )
      } finally {
        figureCall.clear()
      }
      if (reading) tokensUsed += reading.tokens

      steps.push({
        iteration: searches,
        query: `read_figure: ${figureQuestion}`,
        resultCount: reading ? 1 : 0,
        bestSimilarity: null,
        // The reading is reported back to the planner as evidence, so it can
        // decide whether it now has enough. It is deliberately NOT accumulated
        // into `chunks`: a figure reading is not a retrieved passage, it has
        // no similarity, and citing it as one would present a model's reading
        // of a picture as the document's own words.
        found: reading
          ? `    [${reading.documentTitle} p${reading.pageNumber}, figure] ${reading.text.replace(/\s+/g, ' ').slice(0, 400)}`
          : '    (the figure could not be read)',
        elapsedMs: elapsed(),
      })
      continue
    }

    const query = decision.query?.trim()
    if (!query) {
      deps.onPlanFailure?.('search decision carried no query')
      return unavailable()
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
        .map((c) =>
          c.kind === 'figure'
            ? // A figure's indexed text is a search key, not its content, so
              // quoting it back would invite the planner to answer from a
              // label. It is shown as something to LOOK AT instead, with the
              // id read_figure needs — the only place the model ever learns a
              // chunk id, and still no more authority than a hint.
              `    [${c.documentTitle} p${c.pageNumber}] FIGURE (id ${c.chunkId}) — ${c.content.replace(/\s+/g, ' ').slice(0, 120)}. Use read_figure to see what it shows.`
            : `    [${c.documentTitle} p${c.pageNumber}] ${c.content.replace(/\s+/g, ' ').slice(0, 240)}`,
        )
        .join('\n'),
      elapsedMs: elapsed(),
    })
  }
}
