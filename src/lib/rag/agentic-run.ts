import 'server-only'

import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { type LoopStep, effectiveFloor, runAgenticLoop } from './agentic'
import { createChatCompletion } from './client'
import {
  type PlannerDecision,
  SEARCH_TOOL,
  parseToolCallDecision,
} from './planner'
import type { RewriteTurn } from './rewrite'
import {
  type RetrievedChunk,
  retrieveDocumentChunks,
  retrieveForOwner,
} from './retrieve'
import { routeTurn } from './route-intent'
import { resolveScope } from './scope'
import { VERIFY_SYSTEM_PROMPT, parseVerdict } from './verify'

export type AgenticPhase = 'routing' | 'searching' | 'drafting' | 'verifying'

export interface AgenticResult {
  chunks: RetrievedChunk[]
  /** What retrieval actually used — the rewrite, or the original question. */
  query: string
  rewritten: boolean
  /** True when the router decided this turn needs no retrieval at all. */
  skippedRetrieval: boolean
  steps: LoopStep[]
  termination: string
  searches: number
  tokensUsed: number
}

/** Recent turns shown to the planner. Enough for a pronoun, not a summary. */
export const PLANNER_CONTEXT_TURNS = 4

const PLANNER_SYSTEM_PROMPT = `You plan document searches for a retrieval system.

Call search_documents when answering needs information from the user's documents.
The search has NO memory of the conversation. Resolve pronouns and references from the conversation before searching: "what about carrying it over?" after a question about annual leave must be searched as "carrying over annual leave", never as the literal words the user typed.
Look at what previous searches returned. If they found nothing useful, try a DIFFERENT phrasing or a more specific term rather than repeating the same query.
When you have enough to answer, reply with a short confirmation instead of calling the tool.

Never invent document ids. Only pass documentId if one was given to you.`

function historyPrompt(
  question: string,
  turns: readonly RewriteTurn[],
  steps: readonly LoopStep[],
): string {
  const transcript = turns
    .slice(-PLANNER_CONTEXT_TURNS)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n')
  const preamble = transcript ? `Conversation so far:\n${transcript}\n\n` : ''
  if (steps.length === 0) return `${preamble}Question: ${question}`
  const summary = steps
    .map(
      (s) =>
        `- searched "${s.query}" -> ${s.resultCount} passage(s)` +
        (s.bestSimilarity === null
          ? ' (nothing relevant)'
          : `, best relevance ${s.bestSimilarity.toFixed(2)}`) +
        (s.found ? `\n${s.found}` : ''),
    )
    .join('\n')
  return `${preamble}Question: ${question}\n\nSearches so far:\n${summary}\n\nIf these passages already answer the question, say so instead of searching again.`
}

/**
 * Run the agentic retrieval path for one question.
 *
 * ## The security boundary, in one place
 *
 * `userId` and `permittedKbIds` are bound HERE, from the session and the
 * conversation, and closed over by the search function. The planner supplies a
 * query and at most a `documentId` hint. It cannot widen scope, because there
 * is no parameter through which to do so: an out-of-scope `documentId` reaches
 * `retrieveDocumentChunks`, which filters on the same permitted set and returns
 * nothing — indistinguishable from a document that does not exist.
 *
 * Resolved once per question, never per tool call, so a multi-search question
 * cannot end up with citations spanning two different notions of what was
 * permitted (spec 0029 Security).
 */
export async function runAgenticRetrieval(input: {
  userId: string
  permittedKbIds: readonly string[]
  question: string
  /** Ready documents in scope, for whole-document intent resolution. */
  documents: readonly { id: string; title: string }[]
  turns: readonly RewriteTurn[]
  onStep: (phase: AgenticPhase, iteration?: number) => void
  signal: AbortSignal
}): Promise<AgenticResult> {
  const { userId, permittedKbIds, question, documents, turns, onStep, signal } =
    input

  const empty = (over: Partial<AgenticResult> = {}): AgenticResult => ({
    chunks: [],
    query: question,
    rewritten: false,
    skippedRetrieval: false,
    steps: [],
    termination: 'planner-answered',
    searches: 0,
    tokensUsed: 0,
    ...over,
  })

  if (permittedKbIds.length === 0) return empty({ termination: 'no-scope' })

  // 1. Route FIRST, on the original text. Filler is filler whether or not it
  //    gets rewritten, so routing first saves a model call on every "thanks".
  //    Rewriting first cost ~3s per filler turn for no possible benefit.
  onStep('routing')
  if (routeTurn(question) === 'answer-directly') {
    return empty({ skippedRetrieval: true })
  }

  // 2. Whole-document intent is still resolved deterministically, BEFORE the
  //    loop. "summarise the handbook" is an instruction ABOUT a document, not a
  //    question whose answer sits in a passage — measured at 0.077 similarity,
  //    which is noise. Handing that to the planner throws away a correct,
  //    free answer in exchange for hoping the model reinvents it; when the
  //    planner is briefly unavailable it degrades to a refusal instead.
  //
  //    So the fixed pipeline's scope resolution runs first and, when it fires,
  //    short-circuits the loop entirely (spec 0025 behaviour, preserved).
  const scope = resolveScope(question, documents)
  if (scope.mode === 'document') {
    const chunks = await retrieveDocumentChunks(
      userId,
      scope.documentId,
      permittedKbIds,
    )
    return empty({
      chunks,
      query: question,
      termination: 'whole-document',
    })
  }

  // 3. The bounded loop. Reference resolution happens INSIDE it, not as a
  //    separate call — see the note on `effectiveQuery` below.
  let tokens = 0
  const outcome = await runAgenticLoop(
    {
      maxSearches: env.RAG_MAX_SEARCHES,
      maxMs: env.RAG_MAX_LOOP_MS,
      maxTokens: env.RAG_MAX_LOOP_TOKENS,
    },
    {
      plan: async (steps, planSignal) => {
        onStep('searching', steps.length + 1)
        const { choice, tokens: used } = await createChatCompletion(
          [
            { role: 'system', content: PLANNER_SYSTEM_PROMPT },
            { role: 'user', content: historyPrompt(question, turns, steps) },
          ],
          {
            model: env.RAG_PLANNER_MODEL,
            tools: [SEARCH_TOOL],
            maxTokens: 800,
            signal: planSignal,
          },
        )
        tokens += used
        const decision: PlannerDecision | null = parseToolCallDecision(choice)
        return { decision, tokens: used }
      },
      fallbackQuery: question,
      onPlanFailure: (reason, error) => {
        logger.warn('Agentic planner unavailable', {
          userId,
          reason,
          error: error instanceof Error ? error.message : undefined,
        })
      },
      search: async (searchQuery, documentId) =>
        documentId
          ? retrieveDocumentChunks(userId, documentId, permittedKbIds)
          : retrieveForOwner(userId, searchQuery, permittedKbIds),
    },
    signal,
  )

  // What the planner actually searched for on its first attempt. This is the
  // resolved query — the equivalent of a rewrite, produced for free by the
  // call that was going to happen anyway.
  const effectiveQuery = outcome.steps[0]?.query ?? question
  const rewritten = effectiveQuery.trim() !== question.trim()

  // Apply the attempt-scaled floor to everything the loop gathered. Done here,
  // once, rather than inside the loop: the loop must still SEE weak results so
  // its planner can judge that a second phrasing is worth trying.
  const floor = effectiveFloor(
    env.RAG_MIN_SIMILARITY,
    outcome.searches,
    env.RAG_AGENTIC_FLOOR_STEP,
  )
  const kept = outcome.chunks.filter((c) => c.similarity >= floor)

  logger.info('Agentic retrieval', {
    userId,
    rewritten,
    searches: outcome.searches,
    termination: outcome.termination,
    tokensUsed: tokens,
    elapsedMs: outcome.elapsedMs,
    chunkCount: kept.length,
    floor,
  })

  return {
    chunks: kept,
    query: effectiveQuery,
    rewritten,
    skippedRetrieval: false,
    steps: outcome.steps,
    termination: outcome.termination,
    searches: outcome.searches,
    tokensUsed: tokens,
  }
}

/**
 * Check that each cited passage supports what the answer claims about it.
 *
 * One batched call, never a redraft loop — an unbounded verify-redraft cycle is
 * the same failure mode as an unbounded search loop, moved one step later
 * (spec 0029 FR6).
 *
 * Returns the citation indices judged unsupported. Any failure returns an empty
 * list, i.e. it fails OPEN: the gate on whether an answer may be shown at all
 * is the similarity floor, which has already run. A flaky verification call
 * must not be able to turn a correctly-grounded answer into a refusal.
 */
export async function verifyCitations(
  answer: string,
  chunks: readonly RetrievedChunk[],
  signal: AbortSignal,
): Promise<number[]> {
  if (!answer.trim() || chunks.length === 0) return []

  const sources = chunks
    .map(
      (c, i) =>
        `[${i + 1}] ${c.documentTitle}, page ${c.pageNumber}:\n${c.content}`,
    )
    .join('\n\n')

  try {
    const { choice } = await createChatCompletion(
      [
        { role: 'system', content: VERIFY_SYSTEM_PROMPT },
        { role: 'user', content: `Sources:\n${sources}\n\nAnswer:\n${answer}` },
      ],
      {
        model: env.RAG_PLANNER_MODEL,
        maxTokens: 500,
        temperature: 0,
        signal,
      },
    )
    return parseVerdict(choice?.message?.content)
  } catch {
    return []
  }
}
