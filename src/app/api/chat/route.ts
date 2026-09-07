import { and, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'

import { db } from '@/db'
import { conversations, messages } from '@/db/schema'
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
import { SYSTEM_PROMPT, buildUserMessage } from '@/lib/rag/prompt'
import {
  listReadyDocuments,
  retrieveDocumentChunks,
  retrieveForOwner,
} from '@/lib/rag/retrieve'
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
  } else {
    const [created] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: deriveTitle(question) })
      .returning({ id: conversations.id, title: conversations.title })
    if (!created) throw new Error('Failed to create the conversation.')
    conversationId = created.id
    conversationTitle = created.title
  }

  // Persisted BEFORE the model is called, so a question is never lost even if
  // generation fails outright.
  await db.insert(messages).values({
    conversationId,
    ownerId: userId,
    role: 'user',
    content: question,
  })

  // Two retrieval paths (spec 0025): similarity search for content questions,
  // whole-document retrieval for summarise/overview requests. Both are
  // owner-scoped in the SQL itself.
  const scope = resolveScope(question, await listReadyDocuments(userId))
  const retrieved =
    scope.mode === 'document'
      ? await retrieveDocumentChunks(
          userId,
          scope.documentId,
          env.RAG_DOC_SCOPE_MAX_CHUNKS,
        )
      : await retrieveForOwner(userId, question)

  const citations: StoredCitation[] = retrieved.map((chunk, i) => ({
    index: i + 1,
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    pageNumber: chunk.pageNumber,
    similarity: Number(chunk.similarity.toFixed(4)),
  }))

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
    persisted = true
    if (content.length === 0) return
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
        send({ type: 'citations', citations })

        // Nothing relevant: answer without an inference call at all.
        if (retrieved.length === 0) {
          answer = NO_CONTEXT_ANSWER
          send({ type: 'token', value: answer })
          await persistAnswer(answer)
          send({ type: 'done' })
          finish()
          return
        }

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
                choices?: Array<{ delta?: { content?: string } }>
                usage?: {
                  prompt_tokens?: number
                  completion_tokens?: number
                }
              }
              if (parsed.usage) {
                promptTokens = parsed.usage.prompt_tokens ?? null
                completionTokens = parsed.usage.completion_tokens ?? null
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

        const metrics = computeMetrics({
          model: chatModelName(),
          promptTokens,
          completionTokens,
          startedAt,
          firstTokenAt,
          finishedAt: Date.now(),
          sourceCount: citations.length,
          retrieval: scope.mode,
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
