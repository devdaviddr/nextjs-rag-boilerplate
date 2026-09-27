import { and, desc, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'

import { db } from '@/db'
import {
  conversationKnowledgeBases,
  conversations,
  messages,
} from '@/db/schema'
import { getCurrentSession } from '@/lib/auth/session'
import { deriveTitle } from '@/lib/chat/title'
import { aiSettings, refreshAiSettings } from '@/lib/ai-settings'
import {
  MAX_ACTIVITY_EVENTS,
  toActivityLine,
  worthShowing,
} from '@/lib/observability/activity'
import { subscribe } from '@/lib/observability/bus'
import { startRun } from '@/lib/observability/runs'
import {
  annotateContext,
  newRequestId,
  withRequestContext,
} from '@/lib/observability/context'
import { RAG_LIMITS, rateLimit } from '@/lib/rate-limit'
import { clientIpFromHeaders } from '@/lib/request-ip'
import {
  type AnswerDeps,
  type AnswerState,
  type Question,
  answerQuestion,
  answerStore,
} from '@/lib/rag/answer'
import {
  chatModelName,
  createChatStream,
  isRagConfigured,
} from '@/lib/rag/client'
import {
  listReadyDocuments,
  retrieveWholeDocument,
  retrieveForOwner,
} from '@/lib/rag/retrieve'
import { runAgenticRetrieval, verifyAnswer } from '@/lib/rag/agentic-run'
import { resolvePermittedKnowledgeBaseIds } from '@/lib/rag/kb-scope'
import { REWRITE_CONTEXT_TURNS } from '@/lib/rag/rewrite'

/**
 * Grounded document chat (spec 0025), now persisted (spec 0026).
 *
 * This route is the HTTP side: auth, rate limits, the request, the
 * conversation, and the stream. Answering itself — evidence, the refusal,
 * drafting, verification — is `answerQuestion` in `src/lib/rag/answer.ts`
 * (#135), which holds the grounding guarantee.
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
  /** Stream this answer's activity for the chat's drawer (spec 0042 FR12). */
  activity?: unknown
}

function line(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(payload)}\n`)
}

/**
 * Every line logged while answering, streaming included, carries this
 * request's id (spec 0042 FR4). The id is also returned as `X-Request-Id`.
 */
export async function POST(request: Request) {
  const requestId = newRequestId()
  return withRequestContext({ requestId, kind: 'chat' }, () =>
    answer(request, requestId),
  )
}

async function answer(request: Request, requestId: string) {
  await refreshAiSettings()
  const session = await getCurrentSession()
  if (!session?.user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id
  annotateContext({ userId })

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
  // Whether to stream this answer's activity for the chat's drawer (FR12).
  const wantsActivity = body.activity === true
  const isAdmin = (session.user.roles ?? []).includes('admin')
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

  annotateContext({ conversationId })
  // The run record for Observability (spec 0042 FR8): finished once, on
  // whichever way this request ends.
  const run = startRun({
    id: requestId,
    kind: 'question',
    userId,
    conversationId,
    question,
  })

  // Saved BEFORE the model is called, so a question is never lost even if
  // generation fails outright.
  await db.insert(messages).values({
    conversationId,
    ownerId: userId,
    role: 'user',
    content: question,
  })

  const q: Question = {
    userId,
    conversationId,
    question,
    permittedKbIds,
    signal: request.signal,
  }
  const deps: AnswerDeps = {
    settings: () => aiSettings(),
    recentTurns: async (id) =>
      (
        await db
          .select({ role: messages.role, content: messages.content })
          .from(messages)
          .where(eq(messages.conversationId, id))
          .orderBy(desc(messages.createdAt))
          .limit(REWRITE_CONTEXT_TURNS + 1)
      )
        // Drop the question just saved above — it is the thing being
        // rewritten, not context for the rewrite.
        .slice(1)
        .reverse(),
    listReadyDocuments,
    retrieveForOwner,
    retrieveWholeDocument,
    runAgenticRetrieval,
    chatStream: createChatStream,
    verify: verifyAnswer,
    chatModelName,
    finishRun: (outcome) => run.finish(outcome),
  }
  const store = answerStore(
    {
      insert: async (row) => {
        const [saved] = await db
          .insert(messages)
          .values({
            conversationId,
            ownerId: userId,
            role: 'assistant',
            ...row,
            requestId,
          })
          .returning({ id: messages.id })
        // Recents is ordered by activity, not creation.
        await db
          .update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, conversationId))
        return saved?.id ?? null
      },
      revise: async (id, content) => {
        await db
          .update(messages)
          .set({ content })
          .where(and(eq(messages.id, id), eq(messages.ownerId, userId)))
      },
    },
    { userId, conversationId },
  )
  const state: AnswerState = { answer: '', mode: 'search' }

  let closed = false
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  // Hoisted so `cancel()` and a dropped connection can stop it too.
  let stopActivity: () => void = () => {}

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
      // The Agent activity drawer (spec 0042 FR12): this answer's steps and
      // log lines, forwarded as they happen. Plain lines for everyone; the
      // redacted details for admins only. Capped, and never allowed to fail
      // the answer.
      let forwarded = 0
      stopActivity = wantsActivity
        ? subscribe(requestId, (event) => {
            if (forwarded >= MAX_ACTIVITY_EVENTS) return
            if (event.kind === 'log' && !worthShowing(event.message)) return
            forwarded++
            send({
              type: 'activity',
              event:
                event.kind === 'log'
                  ? toActivityLine(event, isAdmin)
                  : { ...event, kind: 'step' },
            })
          })
        : () => {}

      const finish = (): void => {
        stopActivity()
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
        stopActivity()
        void upstreamReader?.cancel().catch(() => undefined)
      })

      send({ type: 'conversation', conversationId, title: conversationTitle })
      send({ type: 'request', requestId })
      await answerQuestion(
        q,
        deps,
        {
          send,
          closed: () => closed,
          finish,
          onReader: (reader) => {
            upstreamReader = reader
          },
        },
        store,
        state,
      )
    },
    cancel() {
      closed = true
      stopActivity()
      run.finish({ status: 'cancelled', mode: state.mode })
      void upstreamReader?.cancel().catch(() => undefined)
      void store.save(state.answer)
    },
  })

  return new Response(stream, {
    headers: {
      'X-Request-Id': requestId,
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
