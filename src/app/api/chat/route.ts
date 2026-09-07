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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(
          line({
            type: 'citations',
            citations: retrieved.map((chunk, i) => ({
              index: i + 1,
              chunkId: chunk.chunkId,
              documentId: chunk.documentId,
              documentTitle: chunk.documentTitle,
              pageNumber: chunk.pageNumber,
              similarity: Number(chunk.similarity.toFixed(4)),
            })),
          }),
        )

        // Nothing relevant: answer without an inference call at all.
        if (retrieved.length === 0) {
          controller.enqueue(line({ type: 'token', value: NO_CONTEXT_ANSWER }))
          controller.enqueue(line({ type: 'done' }))
          controller.close()
          return
        }

        const upstream = await createChatStream([
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(question, retrieved) },
        ])

        const reader = upstream.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
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
                controller.enqueue(line({ type: 'token', value: token }))
              }
            } catch {
              // A malformed frame is skipped rather than aborting the answer;
              // nemotron models are known to emit occasional bad JSON.
            }
          }
        }

        controller.enqueue(line({ type: 'done' }))
        controller.close()
      } catch (error) {
        logger.error('Chat stream failed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        })
        controller.enqueue(
          line({
            type: 'error',
            message: 'The answer could not be generated. Please try again.',
          }),
        )
        controller.close()
      }
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
