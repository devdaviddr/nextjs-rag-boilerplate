import { and, desc, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'

import { db } from '@/db'
import {
  conversationKnowledgeBases,
  conversations,
  messages,
} from '@/db/schema'
import type { StoredCitation } from '@/db/schema'
import { getCurrentSession } from '@/lib/auth/session'
import { computeMetrics, type MessageMetrics } from '@/lib/chat/metrics'
import { deriveTitle } from '@/lib/chat/title'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { RAG_LIMITS, rateLimit } from '@/lib/rate-limit'
import { clientIpFromHeaders } from '@/lib/request-ip'
import {
  chatModelName,
  createChatStream,
  isRagConfigured,
} from '@/lib/rag/client'
import { NO_CONTEXT_ANSWER } from '@/lib/rag/constants'
import { stripUnsupported } from '@/lib/rag/verify'
import { SYSTEM_PROMPT, buildUserMessage } from '@/lib/rag/prompt'
import {
  listReadyDocuments,
  retrieveDocumentChunks,
  retrieveForOwner,
} from '@/lib/rag/retrieve'
import {
  type AgenticResult,
  runAgenticRetrieval,
  verifyCitations,
} from '@/lib/rag/agentic-run'
import type { RetrievedChunk } from '@/lib/rag/retrieve'
import { resolvePermittedKnowledgeBaseIds } from '@/lib/rag/kb-scope'
import { REWRITE_CONTEXT_TURNS } from '@/lib/rag/rewrite'
import { resolveScope } from '@/lib/rag/scope'

/**
 * Grounded document chat (spec 0025), now persisted (spec 0026).
 *
 * The grounding guarantee is unchanged and structural: if retrieval returns
 * nothing above the similarity floor, the chat model is NEVER CALLED and a
 * fixed answer is returned.
 *
 * NDJSON, one JSON object per line:
 *   {"type":"conversation","conversationId":"…","title":"…"}
 *   {"type":"citations","citations":[…]}
 *   {"type":"token","value":"…"}
 *   {"type":"metrics","metrics":{…}}
 *   {"type":"done"}
 *   {"type":"error","message":"…"}
 */

export const dynamic = 'force-dynamic'

interface ChatRequestBody {
  question?: unknown
  conversationId?: unknown
  // Only honoured when CREATING a conversation. A thread's scope is fixed at
  // creation (spec 0028), so every message in it has one auditable scope and a
  // multi-search loop cannot straddle two different notions of what was
  // permitted. Sending it with an existing conversationId is ignored, not an
  // error — the client has no way to change it.
  knowledgeBaseIds?: unknown
}

function line(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(payload)}\n`)
}

export async function POST(request: Request) {
  const session = await getCurrentSession()
  if (!session?.user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  if (!isRagConfigured()) {
    return NextResponse.json(
      { error: 'Document chat is not configured on this deployment.' },
      { status: 503 },
    )
  }

  const h = await headers()
  const limited = rateLimit(
    `rag-chat:${userId}:${clientIpFromHeaders(h)}`,
    RAG_LIMITS.chat.limit,
    RAG_LIMITS.chat.windowMs,
  )
  if (!limited.success) {
    return NextResponse.json(
      { error: 'Too many questions. Please wait a moment.' },
      { status: 429 },
    )
  }

  let body: ChatRequestBody
  try {
    body = (await request.json()) as ChatRequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (question.length === 0) {
    return NextResponse.json(
      { error: 'A question is required.' },
      { status: 400 },
    )
  }
  if (question.length > 2000) {
    return NextResponse.json(
      { error: 'That question is too long.' },
      { status: 400 },
    )
  }

  // Resolve the thread. An existing id is ownership-checked before anything
  // else; the response for someone else's conversation is the same 404 as for
  // one that does not exist.
  const requestedId =
    typeof body.conversationId === 'string' ? body.conversationId : null

  let conversationId: string
  let conversationTitle: string
  let permittedKbIds: string[]

  if (requestedId) {
    const [existing] = await db
      .select({ id: conversations.id, title: conversations.title })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, requestedId),
          eq(conversations.ownerId, userId),
        ),
      )
      .limit(1)
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    conversationId = existing.id
    conversationTitle = existing.title

    // Read the scope back from the join table rather than from the request, so
    // a client cannot widen an existing thread's reach by sending a different
    // selection with a follow-up.
    const scopeRows = await db
      .select({ id: conversationKnowledgeBases.knowledgeBaseId })
      .from(conversationKnowledgeBases)
      .where(eq(conversationKnowledgeBases.conversationId, existing.id))
    permittedKbIds = scopeRows.map((r) => r.id)
  } else {
    // Undefined means "everything I own" — the default for a new conversation.
    // An explicitly EMPTY array means the user deselected everything, and stays
    // empty. The two must never collapse into each other (spec 0028 NFR3).
    const requestedKbIds = Array.isArray(body.knowledgeBaseIds)
      ? body.knowledgeBaseIds.filter((v): v is string => typeof v === 'string')
      : undefined
    permittedKbIds = await resolvePermittedKnowledgeBaseIds(
      userId,
      requestedKbIds,
    )

    const [created] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: deriveTitle(question) })
      .returning({ id: conversations.id, title: conversations.title })
    if (!created) throw new Error('Failed to create the conversation.')
    conversationId = created.id
    conversationTitle = created.title

    if (permittedKbIds.length > 0) {
      await db.insert(conversationKnowledgeBases).values(
        permittedKbIds.map((knowledgeBaseId) => ({
          conversationId: created.id,
          knowledgeBaseId,
        })),
      )
    }
  }

  // Persisted BEFORE the model is called, so a question is never lost even if
  // generation fails outright.
  await db.insert(messages).values({
    conversationId,
    ownerId: userId,
    role: 'user',
    content: question,
  })

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
  const gatherEvidence = async (
    emit: (phase: string, iteration?: number) => void,
  ): Promise<RetrievedChunk[]> => {
    // An empty permitted set cannot produce a candidate row, so it
    // short-circuits before any embedding call. Reached both for a deliberate
    // empty selection and for a user with no knowledge bases at all; the UI
    // prevents the latter from getting this far.
    if (permittedKbIds.length === 0) return []

    if (env.RAG_AGENTIC_ENABLED) {
      // The last few turns, oldest first, for pronoun resolution.
      const priorRows = await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(REWRITE_CONTEXT_TURNS + 1)
      // Drop the question just persisted above — it is the thing being
      // rewritten, not context for the rewrite.
      const turns = priorRows.slice(1).reverse()

      const result = await runAgenticRetrieval({
        userId,
        permittedKbIds,
        question,
        // Whole-document intent ("summarise the handbook") is still resolved
        // deterministically inside, against this KB-scoped list.
        documents: await listReadyDocuments(userId, permittedKbIds),
        turns,
        onStep: emit,
        signal: request.signal,
      })
      agenticTrace = result
      retrievalMode = 'agentic'
      return result.chunks
    }

    // Fixed pipeline (spec 0025): similarity search for content questions,
    // whole-document retrieval for summarise/overview requests.
    const scope = resolveScope(
      question,
      await listReadyDocuments(userId, permittedKbIds),
    )
    retrievalMode = scope.mode
    return scope.mode === 'document'
      ? retrieveDocumentChunks(userId, scope.documentId, permittedKbIds)
      : retrieveForOwner(userId, question, permittedKbIds)
  }

  // Assigned once evidence has been gathered; `persistAnswer` closes over it.
  let citations: StoredCitation[] = []
  let agenticTrace: AgenticResult | null = null
  let retrievalMode: 'search' | 'document' | 'agentic' = 'search'

  /**
   * Commit the answer. Called on normal completion AND on a client
   * disconnect: a conversation showing a question with no answer is a worse
   * failure than a truncated one (spec 0026 NFR3). Guarded so it can only run
   * once.
   */
  let persisted = false
  const persistAnswer = async (
    content: string,
    metrics: MessageMetrics | null = null,
  ): Promise<void> => {
    if (persisted) return
    // Order matters. An EMPTY answer must not burn the once-only latch: the
    // latch exists to stop a double write, and there is no write to dedupe
    // when there is nothing to save. Setting it first meant a cancel during
    // retrieval — when `answer` is still '' — permanently silenced the real
    // save that came moments later, and the answer was lost with no error
    // anywhere. The fixed pipeline hid this behind a ~1s window; the agentic
    // loop widens it to 10-20s, so it fired on most requests.
    if (content.length === 0) return
    persisted = true
    try {
      await db.insert(messages).values({
        conversationId,
        ownerId: userId,
        role: 'assistant',
        content,
        citations,
        metrics,
      })
      // Recents is ordered by activity, not creation.
      await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, conversationId))
    } catch (error) {
      logger.error('Failed to persist the assistant message', {
        userId,
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  let closed = false
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let answer = ''

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown): void => {
        if (closed) return
        try {
          controller.enqueue(line(payload))
        } catch {
          closed = true
        }
      }
      const finish = (): void => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // Already closed by the consumer; nothing to do.
        }
      }

      // Next does not reliably call `cancel()` when the browser drops the
      // socket mid-stream, so react to the request signal directly.
      request.signal.addEventListener('abort', () => {
        closed = true
        void upstreamReader?.cancel().catch(() => undefined)
      })

      try {
        send({ type: 'conversation', conversationId, title: conversationTitle })

        const retrieved = await gatherEvidence((phase, iteration) => {
          send({ type: 'step', phase, iteration })
        })
        citations = retrieved.map((chunk, i) => ({
          index: i + 1,
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          documentTitle: chunk.documentTitle,
          pageNumber: chunk.pageNumber,
          similarity: Number(chunk.similarity.toFixed(4)),
        }))
        send({ type: 'citations', citations })

        // The full trace (spec 0029 FR9). Logged rather than streamed: it is
        // for debugging a bad answer after the fact, and the rewritten query in
        // particular is the first thing to look at when retrieval went wrong.
        if (agenticTrace) {
          logger.info('Agentic trace', {
            userId,
            conversationId,
            original: question,
            query: agenticTrace.query,
            rewritten: agenticTrace.rewritten,
            skippedRetrieval: agenticTrace.skippedRetrieval,
            termination: agenticTrace.termination,
            searches: agenticTrace.searches,
            tokensUsed: agenticTrace.tokensUsed,
            steps: agenticTrace.steps,
          })
        }

        // Nothing relevant: answer without an inference call at all. This is
        // the guarantee made concrete — with no retrieved context there is no
        // drafting call in which to hallucinate. It stays a code path here,
        // around the loop, never something the model is asked to honour.
        if (retrieved.length === 0) {
          answer = NO_CONTEXT_ANSWER
          send({ type: 'token', value: answer })
          await persistAnswer(answer)
          send({ type: 'done' })
          finish()
          return
        }

        send({ type: 'step', phase: 'drafting' })
        const startedAt = Date.now()
        const upstream = await createChatStream(
          [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserMessage(question, retrieved) },
          ],
          request.signal,
        )

        const reader = upstream.getReader()
        upstreamReader = reader
        const decoder = new TextDecoder()
        let buffer = ''
        let firstTokenAt: number | null = null
        let reasoningChars = 0
        let finishReason: string | null = null
        let promptTokens: number | null = null
        let completionTokens: number | null = null

        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const raw of lines) {
            const trimmed = raw.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{
                  finish_reason?: string | null
                  delta?: {
                    content?: string
                    // Reasoning models split their chain-of-thought out of
                    // `content`. We never render it — it is not the answer —
                    // but seeing it tells us the model was working rather than
                    // silent, which is the difference between "no prose yet"
                    // and "no prose at all".
                    reasoning_content?: string
                  }
                }>
                usage?: {
                  prompt_tokens?: number
                  completion_tokens?: number
                }
              }
              if (parsed.usage) {
                promptTokens = parsed.usage.prompt_tokens ?? null
                completionTokens = parsed.usage.completion_tokens ?? null
              }
              if (parsed.choices?.[0]?.finish_reason) {
                finishReason = parsed.choices[0].finish_reason ?? null
              }
              if (parsed.choices?.[0]?.delta?.reasoning_content) {
                reasoningChars +=
                  parsed.choices[0].delta.reasoning_content.length
              }
              const token = parsed.choices?.[0]?.delta?.content
              if (token) {
                firstTokenAt ??= Date.now()
                answer += token
                send({ type: 'token', value: token })
              }
            } catch {
              // A malformed frame is skipped rather than aborting the answer;
              // nemotron models are known to emit occasional bad JSON.
            }
          }
        }

        // A completion that produced no prose is a failure, not an answer.
        //
        // These are reasoning models: they stream chain-of-thought into
        // `reasoning_content` and the answer into `content`. Observed live —
        // 837ms of drafting, one retrieved source, and ZERO content tokens.
        // Persisting that wrote nothing (an empty answer is correctly skipped),
        // so the thread showed a question, a Sources row and no answer at all.
        //
        // Better to say so than to render a blank bubble.
        if (!answer.trim()) {
          logger.error('Drafting produced no answer text', {
            userId,
            conversationId,
            finishReason,
            reasoningChars,
            sourceCount: citations.length,
          })
          send({
            type: 'error',
            message:
              'The model returned an empty answer. Please try again — this is usually transient.',
          })
          send({ type: 'done' })
          finish()
          return
        }

        // Verify citations before the answer is committed (spec 0029 FR6).
        //
        // This runs AFTER streaming rather than before it. Verifying first
        // would mean buffering the whole answer, which kills token streaming
        // and makes time-to-first-token meaningless on every single answer —
        // a permanent regression to prevent a brief exposure that the revision
        // then removes. The PERSISTED record is always the verified text, so
        // reopening the thread never shows an unsupported claim.
        if (
          retrievalMode === 'agentic' &&
          citations.length > 0 &&
          answer.trim()
        ) {
          send({ type: 'step', phase: 'verifying' })
          const unsupported = await verifyCitations(
            answer,
            retrieved,
            request.signal,
          )
          const verified = stripUnsupported(answer, unsupported)
          if (verified.strippedIndices.length > 0) {
            logger.warn('Stripped unsupported citations', {
              userId,
              conversationId,
              stripped: verified.strippedIndices,
            })
            answer = verified.empty ? NO_CONTEXT_ANSWER : verified.text
            send({
              type: 'revision',
              value: answer,
              stripped: verified.strippedIndices,
            })
          }
        }

        const metrics = computeMetrics({
          model: chatModelName(),
          promptTokens,
          completionTokens,
          startedAt,
          firstTokenAt,
          finishedAt: Date.now(),
          sourceCount: citations.length,
          retrieval: retrievalMode,
        })
        await persistAnswer(answer, metrics)
        send({ type: 'metrics', metrics })
        send({ type: 'done' })
        finish()
      } catch (error) {
        const aborted =
          closed ||
          request.signal.aborted ||
          (error instanceof Error && error.name === 'AbortError')
        if (!aborted) {
          logger.error('Chat stream failed', {
            userId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        // Whatever was generated before the failure is still worth keeping.
        await persistAnswer(answer)
        send({
          type: 'error',
          message: 'The answer could not be generated. Please try again.',
        })
        finish()
      }
    },
    cancel() {
      closed = true
      void upstreamReader?.cancel().catch(() => undefined)
      void persistAnswer(answer)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
