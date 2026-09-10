import 'server-only'

import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { createChatCompletion } from './client'

/**
 * HyDE — Hypothetical Document Embeddings (spec 0033 FR6, 0027 §1g).
 *
 * Ask a model to write the answer it EXPECTS, embed that instead of the
 * question, and search with it. A hypothetical answer sits in the same region
 * of embedding space as the real passage; a bare question often does not.
 * 0027 measured the gap this targets: `summarise this document` scored **0.077**
 * against a handbook it summarises, because an instruction shares almost no
 * vocabulary with the prose it is about, while real content questions scored
 * 0.48-0.55.
 *
 * ## This COMPETES with `scope.ts`. It does not complement it.
 *
 * That framing is 0027's and it is the most important thing in this file.
 * `scope.ts` answers the same problem with a regex: spot a whole-document
 * request, skip similarity search, retrieve the document in reading order.
 * HyDE answers it by making the query vector look like the passage. **Both
 * address "the question does not look like the passage that answers it", and
 * running both risks one masking the other's failures** — a HyDE win on
 * summarisation is unmeasurable if `scope.ts` already intercepted every
 * summarisation question before retrieval ran.
 *
 * So spec 0033 FR6 asks for a head-to-head, not an addition: `scope.ts` alone
 * (today), HyDE alone, both. Whichever loses is removed or left off WITH THE
 * NUMBERS RECORDED. Nothing here deletes or weakens `scope.ts`; that decision
 * needs the measurement, and the deterministic path is free and currently
 * works.
 *
 * ## What turning this on actually changes
 *
 * More than reranking does, and the difference is worth being blunt about.
 *
 * `rerank.ts` only permutes, so the similarity gate provably admits the same
 * set with it on or off. **HyDE has no such property.** The vector this
 * produces is what `retrieveForOwner` embeds, so it drives the ANN ordering
 * AND the `similarity` that `RAG_MIN_SIMILARITY` gates on. Answer-to-passage
 * similarity is not on the same scale as question-to-passage similarity — it
 * is generally higher — so a floor calibrated at 0.35 against question vectors
 * is very likely the wrong floor for HyDE vectors, in the direction that
 * admits more.
 *
 * That is not a bug to be fixed here by pinning the gate to the question's own
 * vector. It would defeat the entire point: the case HyDE exists to rescue
 * scored 0.077 as a question, so a question-vector gate refuses it however
 * well HyDE orders the pool. HyDE is only evaluable if its vector decides
 * admission too.
 *
 * It does mean **`RAG_HYDE_ENABLED=true` requires refusal accuracy to be
 * re-measured, and probably `RAG_MIN_SIMILARITY` re-calibrated, before it goes
 * anywhere near a deployment** (0033 NFR2). No new floor knob is added for
 * that: `RetrieveOptions.minSimilarity` already overrides per call, which is
 * the lever the evaluation harness should sweep.
 *
 * ## Failure-open
 *
 * A generation that throws, times out, is disabled or comes back empty returns
 * `null`, and the caller embeds the question exactly as it does today. HyDE is
 * a retrieval experiment, not a correctness dependency.
 *
 * ## Measured 2026-09-11, 9 calls, two models, four questions
 *
 * The prompt works. With a native tool call **8 of 8 parsed**, every passage
 * in a document's voice with section headings, defined terms and concrete
 * numbers — real search vocabulary, which is the whole ask. The one control
 * call without `tools` returned `"Here's a thinking process:"` and no passage,
 * reproducing exactly what `rewrite.ts` and `planner.ts` already record. The
 * tool-call form is not a style preference.
 *
 * **Latency is the cost, and it is large.** Per-call medians: the 120B chat
 * model **9.5s** (4.7-15.8s), `nemotron-3.5-lightning` **18.3s** (12.1-45.5s).
 * The 30B "lightning" model was consistently SLOWER and far less predictable
 * than the 120B one, which is why `RAG_HYDE_MODEL` does not default to
 * `RAG_PLANNER_MODEL`. Either way this runs BEFORE the embedding, the search
 * and the answer, so turning HyDE on roughly doubles time to first token. n=4
 * per model; treat the medians as an order of magnitude, not a number.
 *
 * **Two findings that argue against HyDE**, recorded here because they are the
 * reason to measure rather than assume, and they were not obvious in advance:
 *
 * 1. _It is confidently wrong about documents it has not seen._ Asked to
 *    summarise `rag-sample-handbook` — an HR handbook — it wrote a fluent
 *    excerpt about a retrieval-augmented-generation developer manual, complete
 *    with FAISS index parameters, inferred entirely from the words in the
 *    title. That vector points AWAY from the real document. This is precisely
 *    the case 0027 predicted HyDE would win (`summarise this document` scored
 *    0.077 as a bare question), and it is the case it looks most likely to
 *    lose. `scope.ts` handles it deterministically and for free.
 *
 * 2. _It cannot tell an unanswerable question from an answerable one, and it
 *    is not supposed to._ Given "How much parental leave am I entitled to?" —
 *    the corpus's canonical unanswerable question, and the one whose lexical
 *    score at 0.60 destroyed refusal accuracy in 0027 — it produced a detailed,
 *    plausible parental-leave policy. Embedding that will sit much closer to
 *    the corpus's real leave passages than the bare question does, pushing
 *    similarity UP for a question that must refuse. That is the NFR2 hazard in
 *    concrete form: HyDE's failure mode points straight at the one metric this
 *    project holds at 1.000.
 */

/**
 * Per-attempt deadline for the generation call.
 *
 * `rewrite.ts` is the cautionary measurement here, and it is about this exact
 * shape of call — one small generation on the query path before the first
 * search. Asked for plain text, `nemotron-3.5-lightning` reasoned for 1500+
 * tokens and **53 seconds** without ever emitting its answer; asked through a
 * tool call it answered correctly in **15 seconds**. That is why the rewrite
 * step does not exist any more.
 *
 * HyDE cannot dodge that the way rewriting did — there is no other call
 * already happening that could carry it — so the tool-call form is used, and
 * the deadline is set from the measured tail of the model actually configured
 * by default (see RAG_HYDE_MODEL, and the probe recorded below).
 */
const HYDE_ATTEMPT_TIMEOUT_MS = 25_000

/**
 * Wall-clock budget for the whole step, retries included.
 *
 * Same reasoning as `rerank.ts`: `client.ts` retries its own deadline up to
 * four times with backoff, which is right for an answer that must be produced
 * and wrong for optional work. A caller-supplied signal abort is final and
 * never retried, so passing one is how this gets a hard ceiling. On expiry the
 * call throws, `hypotheticalQuery` catches, and the question is embedded.
 */
const HYDE_BUDGET_MS = 30_000

/**
 * Completion budget.
 *
 * Generous for the reason planner.ts and rerank.ts both record: the default
 * `RAG_HYDE_MODEL` is a REASONING model, its chain of thought is generated
 * whether or not anyone wants it, and it counts against `max_tokens`. A budget
 * sized for the passage alone truncates the model mid-thought and returns a
 * response with no passage in it — which fails open, so the only symptom is a
 * feature that silently never does anything.
 */
const HYDE_MAX_TOKENS = 2000

/**
 * Character cap on the hypothetical before it is embedded.
 *
 * The hypothetical should look like a CHUNK, because a chunk is what it will
 * be compared against — `RAG_CHUNK_TOKENS` is 512, so roughly 2000 characters.
 * A model that ignores the length instruction and writes an essay would
 * otherwise produce a vector averaged over far more text than any single
 * chunk contains, which blurs it toward the corpus mean and makes it match
 * nothing in particular.
 */
const MAX_HYPOTHETICAL_CHARS = 1200

/**
 * Below this a "passage" is a refusal or a fragment, not a passage.
 *
 * This floor is the only thing standing between a hedge and the embedder, and
 * it has to be set well above "not empty" to do that job. `"I do not have the
 * document."` is 27 characters and parses as perfectly valid JSON; embedded,
 * it produces a vector pointing at apology, which will match the least
 * relevant prose in the corpus.
 *
 * 120 characters is roughly twenty words — shorter than any real passage the
 * prompt asks for ("one to two short paragraphs"), and longer than any hedge
 * worth worrying about. The eight passages measured on 2026-09-11 ran
 * **481-965 characters**, so the margin is four-fold and no genuine output is
 * anywhere near it.
 */
const MIN_HYPOTHETICAL_CHARS = 120

/**
 * The generation tool.
 *
 * A tool call rather than "reply with the passage", for the measured reason in
 * `rewrite.ts` and `planner.ts`: with no `tools` array present these models
 * stream their chain of thought into `content`, so the passage — if it arrives
 * at all — is buried in prose that begins "Here's a thinking process:". With
 * `tools` present the reasoning is split into `reasoning_content` and the
 * arguments come back clean.
 */
export const HYDE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'submit_passage',
    description:
      'Submit the hypothetical passage. Call this exactly once, with the ' +
      'passage text and nothing else.',
    parameters: {
      type: 'object',
      properties: {
        passage: {
          type: 'string',
          description:
            'A short factual passage, as it would appear in a document that ' +
            'answers the question. Prose only — no preamble, no caveats.',
        },
      },
      required: ['passage'],
      additionalProperties: false,
    },
  },
}

/**
 * The prompt.
 *
 * Three things it must do, each of which was got wrong by an earlier draft:
 *
 * - **Write the answer, not about the answer.** "A document that answers this
 *   would explain..." is a description of a passage, and it embeds like one.
 * - **Never hedge.** "I don't have access to the document" is the honest reply
 *   and the useless one. The passage is a SEARCH KEY; it is never shown to
 *   anyone and its truth does not matter, only its vocabulary and shape.
 * - **Stay short and concrete.** It is compared against a single chunk.
 */
export const HYDE_SYSTEM_PROMPT = `You write a short hypothetical passage from a document, to be used as a search key. You are a retrieval helper, not an assistant.

Given a question, write the passage you would expect to find in a document that answers it — as if quoting the document directly.

Rules:
- Write the passage itself, in the document's voice. Never describe what such a passage would contain.
- Be specific and confident. Invent plausible concrete details (names, numbers, section headings, defined terms) — they are search vocabulary, not claims. Accuracy does not matter and is never checked.
- Never hedge, never apologise, never say you lack the document. A refusal is useless here.
- One to two short paragraphs, at most 150 words.
- If the question asks for a summary or overview of a document, write an excerpt of the kind of prose that document would contain, not a summary of it.

Call the submit_passage tool exactly once. Do not reply with prose.`

/**
 * A HyDE backend.
 *
 * Narrow on purpose — a question in, a passage or `null` out — so that a
 * cheaper local generator could satisfy it without this file changing. `null`
 * means "no usable hypothetical", which the caller reads as "embed the
 * question", and is the only failure signalling this interface has.
 */
export interface HydeBackend {
  /** Identifies the backend in logs and traces. */
  readonly name: string
  generate(question: string, signal?: AbortSignal): Promise<string | null>
}

/**
 * Pull the passage out of a tool call's `arguments` or a raw reply.
 *
 * Strict in the failure-open direction: anything not clearly a passage returns
 * `null` and the question gets embedded. The length floor is what catches a
 * model that hedged anyway — "I cannot answer that" parses as perfectly valid
 * JSON and would otherwise be embedded as if it were a passage.
 */
export function parseHypothetical(
  content: string | null | undefined,
): string | null {
  if (!content) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const passage = (parsed as Record<string, unknown>).passage
  if (typeof passage !== 'string') return null

  const trimmed = passage.trim()
  if (trimmed.length < MIN_HYPOTHETICAL_CHARS) return null

  return trimmed.slice(0, MAX_HYPOTHETICAL_CHARS)
}

/**
 * The caller's signal and this step's own budget, whichever fires first.
 *
 * Built from an explicit `AbortController` rather than `AbortSignal.any` +
 * `AbortSignal.timeout` for the same reasons `client.ts` and `rerank.ts` do
 * it: the timer can be cleared the moment the call lands instead of being left
 * pending, and a plain `setTimeout` is something a test can drive.
 */
function withBudget(
  signal: AbortSignal | undefined,
  budgetMs: number,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort()

  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })

  const timer = setTimeout(abort, budgetMs)

  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    },
  }
}

/** Generate the hypothetical against `RAG_HYDE_MODEL` in one completion. */
export const llmHyde: HydeBackend = {
  name: 'llm',
  async generate(question, signal) {
    if (!question.trim()) return null

    const budget = withBudget(signal, HYDE_BUDGET_MS)

    try {
      const { choice } = await createChatCompletion(
        [
          { role: 'system', content: HYDE_SYSTEM_PROMPT },
          { role: 'user', content: `Question:\n${question}` },
        ],
        {
          model: env.RAG_HYDE_MODEL,
          tools: [HYDE_TOOL],
          maxTokens: HYDE_MAX_TOKENS,
          // Not 0. A hypothetical is a guess at the vocabulary of an unseen
          // passage, and greedy decoding narrows that guess to the single most
          // likely phrasing. Still low, because this is not creative writing.
          temperature: 0.3,
          timeoutMs: HYDE_ATTEMPT_TIMEOUT_MS,
          signal: budget.signal,
        },
      )

      const call = choice?.message?.tool_calls?.find(
        (c) => c.function?.name === HYDE_TOOL.function.name,
      )
      if (call?.function?.arguments) {
        const passage = parseHypothetical(call.function.arguments)
        if (passage) return passage
      }

      // No content fallback. Unlike a score set, a reasoning model's `content`
      // for this prompt is its chain of thought ABOUT writing a passage, and
      // embedding that would be worse than embedding the question — it is
      // meta-text about the query, which is precisely the failure mode HyDE
      // exists to fix.
      return null
    } finally {
      budget.clear()
    }
  },
}

export interface HydeOptions {
  /** Defaults to the LLM backend. Injected by tests and by a future local one. */
  backend?: HydeBackend
  signal?: AbortSignal
}

/**
 * The text to embed for this question: a hypothetical passage, or `null`.
 *
 * `null` is the "embed the question" signal and is returned for every reason
 * this can fail to produce something usable — disabled, empty question,
 * backend threw, backend timed out, reply unparseable, reply too short to be a
 * passage. The caller never has to distinguish them.
 */
export async function hypotheticalQuery(
  question: string,
  options: HydeOptions = {},
): Promise<string | null> {
  if (!env.RAG_HYDE_ENABLED) return null
  if (!question.trim()) return null

  const backend = options.backend ?? llmHyde

  try {
    const passage = await backend.generate(question, options.signal)
    if (!passage) {
      logger.warn('hyde produced no hypothetical, embedding the question', {
        backend: backend.name,
      })
      return null
    }
    return passage
  } catch (error) {
    // Failure-open, and warn rather than error: an unavailable HyDE backend is
    // a missing experiment, not a broken query.
    logger.warn('hyde failed, embedding the question', {
      backend: backend.name,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
