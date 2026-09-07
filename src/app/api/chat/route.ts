import { headers } from 'next/headers'
import { NextResponse } from 'next/server'

import { getCurrentSession } from '@/lib/auth/session'
import { logger } from '@/lib/logger'
import { RAG_LIMITS, rateLimit } from '@/lib/rate-limit'
import { clientIpFromHeaders } from '@/lib/request-ip'
import { createChatStream, isRagConfigured } from '@/lib/rag/client'
import { NO_CONTEXT_ANSWER } from '@/lib/rag/constants'
import { SYSTEM_PROMPT, buildUserMessage } from '@/lib/rag/prompt'
import { retrieveForOwner } from '@/lib/rag/retrieve'

/**
 * Grounded document chat (spec 0025 FR10/FR11).
 *
 * The grounding guarantee is structural: if retrieval returns nothing above
 * the similarity floor, the chat model is NEVER CALLED and a fixed answer is
 * returned. Refusal is a code path, not a behaviour we hope the model
 * exhibits — so an empty knowledge base cannot produce a confident
 * hallucination, and costs nothing.
 *
 * The response is NDJSON, one JSON object per line:
 *   {"type":"citations","citations":[...]}
 *   {"type":"token","value":"..."}
 *   {"type":"done"}
 *   {"type":"error","message":"..."}
 */

export const dynamic = 'force-dynamic'

interface ChatRequestBody {
  question?: unknown
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

  // Owner-scoped in the SQL itself — see retrieve.ts.
  const retrieved = await retrieveForOwner(userId, question)

  // The client can navigate away mid-answer. Enqueueing into a closed
  // controller throws, and so does the error handler's own enqueue — which
  // turned an ordinary disconnect into a logged error. Guard both, and treat
  // a disconnect as unremarkable.
  let closed = false
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null

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
      // socket mid-stream, so react to the request signal directly: stop the
      // read loop and release the upstream generation. Without this the
      // aborted socket surfaces as an uncaughtException in the server log.
      request.signal.addEventListener('abort', () => {
        closed = true
        void upstreamReader?.cancel().catch(() => undefined)
      })

      try {
        send({
          type: 'citations',
          citations: retrieved.map((chunk, i) => ({
            index: i + 1,
            chunkId: chunk.chunkId,
            documentId: chunk.documentId,
            documentTitle: chunk.documentTitle,
            pageNumber: chunk.pageNumber,
            similarity: Number(chunk.similarity.toFixed(4)),
          })),
        })

        // Nothing relevant: answer without an inference call at all.
        if (retrieved.length === 0) {
          send({ type: 'token', value: NO_CONTEXT_ANSWER })
          send({ type: 'done' })
          finish()
          return
        }

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

        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // SSE frames are newline-delimited; keep any partial tail.
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
              }
              const token = parsed.choices?.[0]?.delta?.content
              if (token) {
                send({ type: 'token', value: token })
              }
            } catch {
              // A malformed frame is skipped rather than aborting the answer;
              // nemotron models are known to emit occasional bad JSON.
            }
          }
        }

        send({ type: 'done' })
        finish()
      } catch (error) {
        // A disconnect is not a failure worth alerting on.
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
        send({
          type: 'error',
          message: 'The answer could not be generated. Please try again.',
        })
        finish()
      }
    },
    cancel() {
      // The consumer went away: stop pulling from the upstream model so the
      // connection (and its rate-limit budget) is released promptly.
      closed = true
      void upstreamReader?.cancel().catch(() => undefined)
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
