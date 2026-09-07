'use server'

import { and, asc, desc, eq } from 'drizzle-orm'

import { db } from '@/db'
import {
  conversationKnowledgeBases,
  conversations,
  messages,
} from '@/db/schema'
import type { StoredCitation, StoredMetrics } from '@/db/schema'
import { getCurrentSession } from '@/lib/auth/session'
import { logger } from '@/lib/logger'
import type { ActionResult } from '@/lib/storage/actions'
import { RECENTS_LIMIT, type RecentConversation } from './recents'

/**
 * Conversation reads and mutations.
 *
 * Every query filters on `ownerId` in the WHERE clause — a conversation id
 * appears in the URL and is therefore guessable in a way a chunk id was not,
 * so ownership is checked on the query rather than after it (spec 0026 NFR1).
 */

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations: StoredCitation[]
  metrics: StoredMetrics | null
}

async function requireUserId(): Promise<string> {
  const session = await getCurrentSession()
  if (!session?.user.id) throw new Error('You must be signed in.')
  return session.user.id
}

/** The signed-in user's conversations, most recently active first. */
export async function listConversations(): Promise<RecentConversation[]> {
  const userId = await requireUserId()
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(eq(conversations.ownerId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(RECENTS_LIMIT)
}

/**
 * One conversation with its messages, or null.
 *
 * Null covers both "does not exist" and "belongs to someone else" so the
 * caller renders the same 404 either way — no existence signal.
 */
export async function getConversation(conversationId: string): Promise<{
  id: string
  title: string
  messages: ConversationMessage[]
  /**
   * The knowledge bases this thread may search. Fixed when the conversation
   * was created (spec 0028), so the UI renders it as state, not a control.
   * Empty for a thread created with nothing selected.
   */
  knowledgeBaseIds: string[]
} | null> {
  const userId = await requireUserId()

  const [conversation] = await db
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.ownerId, userId),
      ),
    )
    .limit(1)
  if (!conversation) return null

  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      citations: messages.citations,
      metrics: messages.metrics,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.ownerId, userId),
      ),
    )
    .orderBy(asc(messages.createdAt))

  const scopeRows = await db
    .select({ id: conversationKnowledgeBases.knowledgeBaseId })
    .from(conversationKnowledgeBases)
    .where(eq(conversationKnowledgeBases.conversationId, conversation.id))

  return {
    ...conversation,
    messages: rows,
    knowledgeBaseIds: scopeRows.map((r) => r.id),
  }
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<ActionResult<{ title: string }>> {
  const userId = await requireUserId()

  const trimmed = title.trim().slice(0, 200)
  if (trimmed.length === 0) {
    return { ok: false, error: 'A title is required.' }
  }

  const updated = await db
    .update(conversations)
    .set({ title: trimmed })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.ownerId, userId),
      ),
    )
    .returning({ id: conversations.id })

  if (updated.length === 0) {
    return { ok: false, error: 'Conversation not found.' }
  }
  return { ok: true, data: { title: trimmed } }
}

/** Delete a conversation. Messages cascade at the database level. */
export async function deleteConversation(
  conversationId: string,
): Promise<ActionResult<null>> {
  const userId = await requireUserId()

  const deleted = await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.ownerId, userId),
      ),
    )
    .returning({ id: conversations.id })

  if (deleted.length === 0) {
    return { ok: false, error: 'Conversation not found.' }
  }

  logger.info('Conversation deleted', { userId, conversationId })
  return { ok: true, data: null }
}
