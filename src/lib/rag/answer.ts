import 'server-only'

import type { StoredCitation } from '@/db/schema'
import { toStoredCitations } from '@/lib/chat/citations'
import { computeMetrics, type MessageMetrics } from '@/lib/chat/metrics'
import { logger } from '@/lib/logger'
import { beginSpan, span } from '@/lib/observability/runs'
import type { AgenticResult, runAgenticRetrieval } from './agentic-run'
import type { ChatMessage } from './client'
import { NO_CONTEXT_ANSWER } from './constants'
import { planRoute } from './plan-route'
import { type ToolOutput, buildUserMessage, systemPrompt } from './prompt'
import type {
  RetrievedChunk,
  listReadyDocuments,
  retrieveForOwner,
  retrieveWholeDocument,
} from './retrieve'
import type { RewriteTurn } from './rewrite'
import { resolveScope } from './scope'
import { toolRegistry } from './tools'
import { draftFailureMessage, draftRetryDelayMs, parseStreamFrame } from './sse'
import { stripUnsupported } from './verify'

/**
 * Answering one question, from evidence to verified answer (#135).
 *
 * Moved out of the chat route so it can be tested: everything with a side
 * effect (the database, the model, the stream to the browser, the run record)
 * comes in as a dependency. The route keeps what is HTTP: auth, rate limits,
 * the request body, the conversation, and the stream's plumbing.
 *
 * The grounding guarantee is unchanged and structural: if retrieval returns
 * nothing above the similarity floor, the chat model is NEVER CALLED and a
 * fixed answer is returned.
 */

export type RetrievalMode = 'search' | 'document' | 'agentic'

/** What `gatherEvidence` found, and how. */
export interface Evidence {
  chunks: RetrievedChunk[]
  mode: RetrievalMode
  /** The agentic loop's trace, when the question was planned. */
  agentic: AgenticResult | null
  /** A whole-document request that read only part of a long document (#99). */
  coverage?: { shown: number; total: number }
}

export interface Question {
  userId: string
  conversationId: string
  question: string
  /** Bound from the session and the conversation, never from the model. */
  permittedKbIds: readonly string[]
  signal: AbortSignal
}

export interface EvidenceDeps {
  settings(): {
    RAG_AGENTIC_ENABLED: boolean
    RAG_AGENTIC_ROUTE: 'always' | 'adaptive'
  }
  /** The last few turns before this question, oldest first. */
  recentTurns(conversationId: string): Promise<RewriteTurn[]>
  listReadyDocuments: typeof listReadyDocuments
  retrieveForOwner: typeof retrieveForOwner
  retrieveWholeDocument: typeof retrieveWholeDocument
  runAgenticRetrieval: typeof runAgenticRetrieval
  /**
   * Whether any tool is registered (spec 0044 FR2). Tools exist only on the
   * agentic path, so with any registered every question is planned.
   * Defaults to the registry.
   */
  hasTools?: () => boolean
}

/**
 * Gather evidence.
 *
 * Runs INSIDE the stream (spec 0029 FR7) so phase events can reach the client
 * while it works. The agentic path can take many seconds before any prose
 * exists; without a heartbeat the user stares at a spinner with no idea
 * whether anything is happening.
 *
 * Both paths bind `userId` and `permittedKbIds` from the session and the
 * conversation. Neither reads scope from anything the model produced.
 */
export async function gatherEvidence(
  q: Question,
  emit: (phase: string, iteration?: number) => void,
  deps: EvidenceDeps,
): Promise<Evidence> {
  const { userId, question, permittedKbIds } = q
  // An empty permitted set cannot produce a candidate row, so it
  // short-circuits before any embedding call. Reached both for a deliberate
  // empty selection and for a user with no knowledge bases at all; the UI
  // prevents the latter from getting this far.
  if (permittedKbIds.length === 0) {
    return { chunks: [], mode: 'search', agentic: null }
  }

  const settings = deps.settings()
  // The last few turns, for pronoun resolution. Read before deciding whether
  // to plan, because that decision depends on them.
  const turns = settings.RAG_AGENTIC_ENABLED
    ? await deps.recentTurns(q.conversationId)
    : []
  // Plan only when it pays (spec 0043): follow-ups and multi-part
  // questions. A standalone question takes the fixed pipeline below.
  const route = planRoute(question, turns)
  const hasTools = (deps.hasTools ?? (() => toolRegistry().size > 0))()
  const plan =
    settings.RAG_AGENTIC_ENABLED &&
    (settings.RAG_AGENTIC_ROUTE === 'always' || route.plan || hasTools)
  if (settings.RAG_AGENTIC_ENABLED) {
    logger.info(plan ? 'Planning this question' : 'Skipping the planner', {
      category: 'agent',
      route: route.reason,
      mode: settings.RAG_AGENTIC_ROUTE,
    })
  }

  if (plan) {
    const result = await deps.runAgenticRetrieval({
      userId,
      permittedKbIds,
      question,
      // Whole-document intent ("summarise the handbook") is still resolved
      // deterministically inside, against this KB-scoped list.
      documents: await deps.listReadyDocuments(userId, permittedKbIds),
      turns,
      onStep: emit,
      signal: q.signal,
    })
    return { chunks: result.chunks, mode: 'agentic', agentic: result }
  }

  // Fixed pipeline (spec 0025): similarity search for content questions,
  // whole-document retrieval for summarise/overview requests.
  const scope = resolveScope(
    question,
    await deps.listReadyDocuments(userId, permittedKbIds),
  )
  if (scope.mode !== 'document') {
    return {
      chunks: await deps.retrieveForOwner(userId, question, permittedKbIds),
      mode: scope.mode,
      agentic: null,
    }
  }
  const whole = await deps.retrieveWholeDocument(
    userId,
    scope.documentId,
    permittedKbIds,
  )
  return {
    chunks: whole.chunks,
    mode: 'document',
    agentic: null,
    coverage: { shown: whole.chunks.length, total: whole.totalChunks },
  }
}

/** Where the answer is saved. */
export interface AnswerWrites {
  /** Insert the assistant message; returns its id. */
  insert(row: {
    content: string
    citations: StoredCitation[]
    metrics: MessageMetrics | null
  }): Promise<string | null>
  /** Replace a saved message's text with its verified version. */
  revise(id: string, content: string): Promise<void>
}

/**
 * The answer's row: saved once, then revised in place.
 *
 * `save` is called on normal completion AND on a client disconnect: a
 * conversation showing a question with no answer is a worse failure than a
 * truncated one (spec 0026 NFR3). Guarded so it can only run once; a later
 * citation revision updates the same row (`revise`).
 */
export function answerStore(writes: AnswerWrites, context: object) {
  let persisted = false
  let id: string | null = null
  let citations: StoredCitation[] = []
  return {
    setCitations(next: StoredCitation[]): void {
      citations = next
    },
    async save(
      content: string,
      metrics: MessageMetrics | null = null,
    ): Promise<void> {
      if (persisted) return
      // Order matters. An EMPTY answer must not burn the once-only latch: the
      // latch exists to stop a double write, and there is no write to dedupe
      // when there is nothing to save. Setting it first meant a cancel during
      // retrieval — when the answer is still '' — permanently silenced the
      // real save that came moments later, and the answer was lost with no
      // error anywhere.
      if (content.length === 0) return
      persisted = true
      try {
        id = await writes.insert({ content, citations, metrics })
      } catch (error) {
        logger.error('Failed to persist the assistant message', {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
    /**
     * Replace the saved answer with its verified text (#48). The draft is
     * saved BEFORE verification so the composer can unlock the moment
     * drafting ends without a quick next question being stored ahead of this
     * answer; this keeps the "saved record is the verified text" guarantee
     * once verification returns.
     */
    async revise(content: string): Promise<void> {
      if (!id) return
      try {
        await writes.revise(id, content)
      } catch (error) {
        logger.error('Failed to persist the verified answer', {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

export type AnswerStore = ReturnType<typeof answerStore>

/** How a run ended, for the run record (spec 0042 FR8). */
export interface RunOutcome {
  status: 'ok' | 'refused' | 'error' | 'cancelled'
  mode: RetrievalMode
  termination?: string | null
  ttftMs?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
  sourceCount?: number
  bestSimilarity?: number | null
  error?: string
}

export interface AnswerDeps extends EvidenceDeps {
  chatStream(
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>
  verify(
    answer: string,
    chunks: readonly RetrievedChunk[],
    signal: AbortSignal,
    toolResults?: readonly ToolOutput[],
  ): Promise<number[]>
  chatModelName(): string
  finishRun(outcome: RunOutcome): void
  sleep?(ms: number): Promise<void>
}

/** The stream to the browser, as the route owns it. */
export interface AnswerIO {
  send(event: Record<string, unknown>): void
  /** True once the browser has gone or the stream was closed. */
  closed(): boolean
  /** Close the stream (idempotent). */
  finish(): void
  /** The current upstream reader, so a disconnect can cancel it. */
  onReader(reader: ReadableStreamDefaultReader<Uint8Array>): void
}

/**
 * What an answer has produced so far. Owned by the caller so a disconnect
 * (`cancel`) can still save the partial answer and record the mode.
 */
export interface AnswerState {
  answer: string
  mode: RetrievalMode
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Answer one question onto `io`: evidence, a refusal or a streamed draft,
 * verification, and the run record. Never throws; a failure is sent as an
 * `error` event and whatever was drafted is saved.
 */
export async function answerQuestion(
  q: Question,
  deps: AnswerDeps,
  io: AnswerIO,
  store: AnswerStore,
  state: AnswerState,
): Promise<void> {
  const { userId, conversationId, question, signal } = q
  const sleep = deps.sleep ?? defaultSleep
  let agentic: AgenticResult | null = null

  try {
    const evidence = await span('retrieve', async (step) => {
      const found = await gatherEvidence(
        q,
        (phase, iteration) => io.send({ type: 'step', phase, iteration }),
        deps,
      )
      step.set({ mode: found.mode, passages: found.chunks.length })
      return found
    })
    state.mode = evidence.mode
    agentic = evidence.agentic
    const retrieved = evidence.chunks
    const bestSimilarity = retrieved.reduce<number | null>(
      (best, c) => (best === null || c.similarity > best ? c.similarity : best),
      null,
    )
    // Section parents are flagged so the panel highlights the whole run.
    const citations = toStoredCitations(retrieved)
    store.setCitations(citations)
    io.send({ type: 'citations', citations })

    // The full trace (spec 0029 FR9). Logged rather than streamed: it is for
    // debugging a bad answer after the fact, and the rewritten query in
    // particular is the first thing to look at when retrieval went wrong.
    if (agentic) {
      logger.info('Agentic trace', {
        userId,
        conversationId,
        original: question,
        query: agentic.query,
        rewritten: agentic.rewritten,
        skippedRetrieval: agentic.skippedRetrieval,
        termination: agentic.termination,
        searches: agentic.searches,
        tokensUsed: agentic.tokensUsed,
        steps: agentic.steps,
      })
    }

    // Nothing relevant: answer without an inference call at all. This is the
    // guarantee made concrete — with no retrieved context there is no drafting
    // call in which to hallucinate. It stays a code path here, around the
    // loop, never something the model is asked to honour.
    //
    // A registered tool's result is evidence too (spec 0044 FR9). With no
    // tools registered this is exactly the old condition.
    const toolResults = agentic?.toolResults ?? []
    if (retrieved.length === 0 && toolResults.length === 0) {
      state.answer = NO_CONTEXT_ANSWER
      io.send({ type: 'token', value: state.answer })
      await store.save(state.answer)
      io.send({ type: 'done' })
      io.finish()
      deps.finishRun({
        status: 'refused',
        mode: state.mode,
        termination: agentic?.termination ?? 'no-evidence',
        sourceCount: 0,
        bestSimilarity,
      })
      return
    }

    io.send({ type: 'step', phase: 'drafting' })
    const startedAt = Date.now()
    const drafting = beginSpan('draft', { sources: citations.length })
    // Hoisted above the retry loop so a second attempt overwrites them rather
    // than shadowing, and so the empty-answer diagnostic below can still see
    // what the last attempt produced.
    let firstTokenAt: number | null = null
    let reasoningChars = 0
    let finishReason: string | null = null
    let rawSample = ''
    let promptTokens: number | null = null
    let completionTokens: number | null = null
    // An error sent INSIDE a 200 stream (#43), from the last attempt.
    let upstreamError: { code: number | null; message: string } | null = null

    // Draft, with ONE retry on an empty stream.
    //
    // Measured: the upstream intermittently returns a 200 SSE body that yields
    // no frames at all — no content, no reasoning, not even a finish_reason —
    // in ~200ms, while the identical request by hand succeeds 5 times out of
    // 5. Retrying once converts that transient into an answer instead of an
    // apology.
    //
    // Bounded at two attempts, and skipped entirely when the client has gone
    // away: retrying into a closed connection just burns a request against a
    // 40/min ceiling.
    for (let draft = 0; draft < 2; draft++) {
      if (draft > 0) {
        if (io.closed() || signal.aborted) break
        const delayMs = draftRetryDelayMs(upstreamError !== null)
        logger.warn('Drafting returned nothing; retrying once', {
          userId,
          conversationId,
          upstreamError,
          delayMs,
        })
        // Backoff: the old immediate retry hit the same overloaded upstream
        // 230ms later (#43).
        await sleep(delayMs)
        if (io.closed() || signal.aborted) break
        upstreamError = null
      }
      const upstream = await deps.chatStream(
        [
          { role: 'system', content: systemPrompt(!!agentic?.toolResults) },
          {
            role: 'user',
            // The planner's reading of a follow-up, so the writer knows what
            // "it" refers to (#97).
            content: buildUserMessage(
              question,
              retrieved,
              agentic?.rewritten ? agentic.query : undefined,
              // And, for a long document, that it read only part (#99).
              agentic?.coverage ?? evidence.coverage,
              // What registered tools returned (spec 0044 FR6).
              agentic?.toolResults,
            ),
          },
        ],
        signal,
      )

      const reader = upstream.getReader()
      io.onReader(reader)
      const decoder = new TextDecoder()
      let buffer = ''

      while (!io.closed()) {
        const { done, value } = await reader.read()
        if (done) break
        const decoded = decoder.decode(value, { stream: true })
        if (rawSample.length < 600) rawSample += decoded
        buffer += decoded

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const raw of lines) {
          const trimmed = raw.trim()
          if (!trimmed.startsWith('data:')) continue
          const frame = parseStreamFrame(trimmed.slice(5))
          if (frame.kind === 'skip') continue
          if (frame.kind === 'error') {
            // The upstream failed after answering 200. Stop reading this
            // attempt; the retry below backs off and tries once more.
            upstreamError = { code: frame.code, message: frame.message }
            logger.warn('Upstream error inside the drafting stream', {
              userId,
              conversationId,
              code: frame.code,
              message: frame.message,
              hadText: state.answer.length > 0,
            })
            break
          }
          if (frame.usage) {
            promptTokens = frame.usage.promptTokens
            completionTokens = frame.usage.completionTokens
          }
          if (frame.finishReason) finishReason = frame.finishReason
          // Reasoning models split their chain-of-thought out of `content`.
          // It is never rendered, but its presence says the model was working
          // rather than silent.
          reasoningChars += frame.reasoningChars
          if (frame.content) {
            firstTokenAt ??= Date.now()
            state.answer += frame.content
            io.send({ type: 'token', value: frame.content })
          }
        }
        if (upstreamError) {
          await reader.cancel().catch(() => {})
          break
        }
      }
      if (state.answer.trim()) break
    }

    // A completion that produced no prose is a failure, not an answer.
    //
    // These are reasoning models: they stream chain-of-thought into
    // `reasoning_content` and the answer into `content`. Observed live — 837ms
    // of drafting, one retrieved source, and ZERO content tokens. Saving that
    // wrote nothing (an empty answer is correctly skipped), so the thread
    // showed a question, a Sources row and no answer at all.
    //
    // Better to say so than to render a blank bubble.
    if (!state.answer.trim()) {
      logger.error('Drafting produced no answer text', {
        userId,
        conversationId,
        finishReason,
        reasoningChars,
        sourceCount: citations.length,
        elapsedMs: Date.now() - startedAt,
        rawSample: rawSample.slice(0, 600),
        upstreamError,
      })
      io.send({ type: 'error', message: draftFailureMessage(upstreamError) })
      io.send({ type: 'done' })
      io.finish()
      drafting.set({ finishReason, upstreamError })
      drafting.end({ status: 'error', model: deps.chatModelName() })
      deps.finishRun({
        status: 'error',
        mode: state.mode,
        termination: agentic?.termination ?? null,
        sourceCount: citations.length,
        bestSimilarity,
        error: upstreamError?.message ?? 'Drafting produced no answer text',
      })
      return
    }

    // Drafting ends here. The metrics clock stops now, not after
    // verification: tokens/sec and total time describe the answer the user
    // watched stream in, not the post-hoc check that follows it (#42).
    const draftedAt = Date.now()
    drafting.set({
      finishReason,
      ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
      answerChars: state.answer.length,
      answer: state.answer,
    })
    drafting.end({
      model: deps.chatModelName(),
      tokens:
        promptTokens !== null || completionTokens !== null
          ? (promptTokens ?? 0) + (completionTokens ?? 0)
          : null,
    })

    // The answer is complete: save it and send its metrics now. `metrics` is
    // the client's signal that the composer may unlock (#48) — it no longer
    // waits for verification, which continues below and revises this same
    // row if it strips anything.
    const metrics = computeMetrics({
      model: deps.chatModelName(),
      promptTokens,
      completionTokens,
      startedAt,
      firstTokenAt,
      finishedAt: draftedAt,
      sourceCount: citations.length,
      retrieval: state.mode,
    })
    // Which tools the answer drew on, kept with it (#164): a number from a
    // tool must not look like it came from nowhere.
    if (toolResults.length > 0) {
      metrics.tools = [...new Set(toolResults.map((t) => t.name))]
    }
    await store.save(state.answer, metrics)
    io.send({ type: 'metrics', metrics })

    // Verify the answer (spec 0029 FR6), after it is readable. Every grounded
    // answer, fixed path included (#127): the fixed path cites sources just
    // the same, and can blur them just the same.
    //
    // This runs AFTER streaming rather than before it. Verifying first would
    // mean buffering the whole answer, which kills token streaming and makes
    // time-to-first-token meaningless on every single answer — a permanent
    // regression to prevent a brief exposure that the revision then removes.
    // The SAVED record is always the verified text, so reopening the thread
    // never shows an unsupported claim.
    if (
      (citations.length > 0 || toolResults.length > 0) &&
      state.answer.trim()
    ) {
      io.send({ type: 'step', phase: 'verifying' })
      const unsupported = await span('verify', async (step) => {
        const found = await deps.verify(
          state.answer,
          retrieved,
          signal,
          agentic?.toolResults,
        )
        step.set({ unsupported: found.length })
        return found
      })
      const verified = stripUnsupported(state.answer, unsupported)
      if (verified.strippedSentences > 0) {
        logger.warn('Stripped unsupported sentences', {
          userId,
          conversationId,
          sentences: verified.strippedSentences,
          stripped: verified.strippedIndices,
        })
        state.answer = verified.empty ? NO_CONTEXT_ANSWER : verified.text
        await store.revise(state.answer)
        io.send({
          type: 'revision',
          value: state.answer,
          stripped: verified.strippedIndices,
        })
      }
    }

    io.send({ type: 'done' })
    io.finish()
    deps.finishRun({
      status: 'ok',
      mode: state.mode,
      termination: agentic?.termination ?? null,
      ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
      promptTokens,
      completionTokens,
      sourceCount: citations.length,
      bestSimilarity,
    })
  } catch (error) {
    const aborted =
      io.closed() ||
      signal.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    if (!aborted) {
      logger.error('Chat stream failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    deps.finishRun({
      status: aborted ? 'cancelled' : 'error',
      mode: state.mode,
      termination: agentic?.termination ?? null,
      error: error instanceof Error ? error.message : String(error),
    })
    // Whatever was generated before the failure is still worth keeping.
    await store.save(state.answer)
    io.send({
      type: 'error',
      message: 'The answer could not be generated. Please try again.',
    })
    io.finish()
  }
}
