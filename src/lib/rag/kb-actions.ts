'use server'

import { and, asc, count, eq, inArray } from 'drizzle-orm'

import { db } from '@/db'
import { chunks, documents, files, knowledgeBases } from '@/db/schema'
import { getCurrentSession } from '@/lib/auth/session'
import { logger } from '@/lib/logger'
import { deleteObject } from '@/lib/storage/client'
import type { ActionResult } from '@/lib/storage/actions'
import { redirect } from 'next/navigation'

export interface KnowledgeBaseSummary {
  id: string
  name: string
  description: string | null
  documentCount: number
  readyCount: number
  createdAt: Date
}

const MAX_NAME_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 280

/**
 * The caller's id, or a redirect to sign in.
 *
 * `redirect()` rather than `throw`: a lapsed session is an EXPECTED failure,
 * and Next redacts a thrown Error's message in production builds — so the
 * user was shown "an error occurred" with nothing to act on, while the one
 * thing they needed to do was sign in again.
 */
async function requireUserId(): Promise<string> {
  const session = await getCurrentSession()
  if (!session?.user.id) {
    redirect('/login')
  }
  return session.user.id
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim().replace(/\s+/g, ' ')
  if (!name || name.length > MAX_NAME_LENGTH) return null
  return name
}

/**
 * Assert a knowledge base exists and belongs to the caller.
 *
 * Returns the id, or null. Callers must translate null into the SAME response
 * they would give for a missing row — never "forbidden", which would confirm
 * the row exists. Same rule `deleteDocument` already follows.
 */
async function ownedKnowledgeBaseId(
  userId: string,
  knowledgeBaseId: string,
): Promise<string | null> {
  const row = await db.query.knowledgeBases.findFirst({
    where: eq(knowledgeBases.id, knowledgeBaseId),
    columns: { id: true, ownerId: true },
  })
  return row && row.ownerId === userId ? row.id : null
}

/**
 * Just this knowledge base's name, for `generateMetadata`.
 *
 * `listMyKnowledgeBases` runs two grouped joins to count documents; a
 * `<title>` needs one string, and there is no request-level dedupe between
 * `generateMetadata` and the page body, so it ran both passes twice per view.
 *
 * Owner-scoped: someone else's knowledge base and one that does not exist
 * both return null, the same non-signal the page's 404 relies on.
 */
export async function getKnowledgeBaseName(
  knowledgeBaseId: string,
): Promise<string | null> {
  const userId = await requireUserId()
  const row = await db.query.knowledgeBases.findFirst({
    where: and(
      eq(knowledgeBases.id, knowledgeBaseId),
      eq(knowledgeBases.ownerId, userId),
    ),
    columns: { name: true },
  })
  return row?.name ?? null
}

/** List the signed-in user's knowledge bases, oldest first, with counts. */
export async function listMyKnowledgeBases(): Promise<KnowledgeBaseSummary[]> {
  const userId = await requireUserId()

  // Left join + groupBy rather than a correlated subquery: Drizzle renders
  // interpolated columns unqualified inside a raw `sql` fragment, which is the
  // bug that once made every document report zero chunks. See actions.ts.
  const rows = await db
    .select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      description: knowledgeBases.description,
      createdAt: knowledgeBases.createdAt,
      documentCount: count(documents.id),
    })
    .from(knowledgeBases)
    .leftJoin(documents, eq(documents.knowledgeBaseId, knowledgeBases.id))
    .where(eq(knowledgeBases.ownerId, userId))
    .groupBy(knowledgeBases.id)
    .orderBy(asc(knowledgeBases.createdAt))

  // `readyCount` needs its own pass — counting two different predicates in one
  // grouped query needs FILTER, which is clearer to read separately here.
  const ready = await db
    .select({
      knowledgeBaseId: documents.knowledgeBaseId,
      readyCount: count(documents.id),
    })
    .from(documents)
    .where(and(eq(documents.ownerId, userId), eq(documents.status, 'ready')))
    .groupBy(documents.knowledgeBaseId)
  const readyByKb = new Map(
    ready.map((r) => [r.knowledgeBaseId, Number(r.readyCount)]),
  )

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.createdAt,
    documentCount: Number(r.documentCount),
    readyCount: readyByKb.get(r.id) ?? 0,
  }))
}

/** Create a knowledge base. Names are deliberately not unique — see schema. */
export async function createKnowledgeBase(input: {
  name: string
  description?: string
}): Promise<ActionResult<KnowledgeBaseSummary>> {
  const userId = await requireUserId()

  const name = cleanName(input?.name)
  if (!name) {
    return {
      ok: false,
      error: `Give the knowledge base a name of up to ${MAX_NAME_LENGTH} characters.`,
    }
  }

  const description =
    typeof input?.description === 'string' && input.description.trim()
      ? input.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : null

  const [row] = await db
    .insert(knowledgeBases)
    .values({ ownerId: userId, name, description })
    .returning()
  if (!row) throw new Error('Failed to create the knowledge base.')

  logger.info('Knowledge base created', { userId, knowledgeBaseId: row.id })
  return {
    ok: true,
    data: {
      id: row.id,
      name: row.name,
      description: row.description,
      documentCount: 0,
      readyCount: 0,
      createdAt: row.createdAt,
    },
  }
}

/** Rename a knowledge base. */
export async function renameKnowledgeBase(
  knowledgeBaseId: string,
  rawName: string,
): Promise<ActionResult<null>> {
  const userId = await requireUserId()

  const owned = await ownedKnowledgeBaseId(userId, knowledgeBaseId)
  if (!owned) return { ok: false, error: 'Knowledge base not found.' }

  const name = cleanName(rawName)
  if (!name) {
    return {
      ok: false,
      error: `Give the knowledge base a name of up to ${MAX_NAME_LENGTH} characters.`,
    }
  }

  await db
    .update(knowledgeBases)
    .set({ name })
    .where(eq(knowledgeBases.id, owned))
  return { ok: true, data: null }
}

/**
 * Delete a knowledge base, its documents, their chunks and their stored objects.
 *
 * The database cascades documents and chunks. It never cascades S3 objects, so
 * those are removed explicitly FIRST — the rule spec 0007 established and
 * `deleteDocument` / `deleteAllFilesForUser` already follow. Deleting the rows
 * first would strand every object with no remaining pointer to it.
 */
export async function deleteKnowledgeBase(
  knowledgeBaseId: string,
): Promise<ActionResult<null>> {
  const userId = await requireUserId()

  const owned = await ownedKnowledgeBaseId(userId, knowledgeBaseId)
  if (!owned) return { ok: false, error: 'Knowledge base not found.' }

  const docs = await db
    .select({ fileId: documents.fileId })
    .from(documents)
    .where(eq(documents.knowledgeBaseId, owned))
  const fileIds = docs.map((d) => d.fileId)

  if (fileIds.length > 0) {
    const rows = await db
      .select({ id: files.id, bucketKey: files.bucketKey })
      .from(files)
      .where(inArray(files.id, fileIds))

    // Synchronous sweep. Documents are expected in the dozens per KB in this
    // boilerplate; if that ever changes, move this to `after()` and accept
    // orphaned objects on a crash as the cheaper failure than a stuck request.
    await Promise.all(rows.map((r) => deleteObject(r.bucketKey)))
    await db.delete(files).where(inArray(files.id, fileIds))
  }

  await db.delete(knowledgeBases).where(eq(knowledgeBases.id, owned))

  logger.info('Knowledge base deleted', {
    userId,
    knowledgeBaseId: owned,
    documentCount: fileIds.length,
  })
  return { ok: true, data: null }
}

/**
 * Move a document to another knowledge base the same user owns.
 *
 * Re-tags rows only. Chunk content and embeddings are independent of which KB
 * a document sits in, so there is no re-extraction, no re-chunking and no
 * re-embedding — which is the entire reason one-KB-per-document is liveable
 * (spec 0028 FR4). Re-ingestion is the most expensive operation in this system;
 * fixing a filing mistake must not cost hundreds of rate-limited embedding calls.
 */
export async function moveDocument(
  documentId: string,
  knowledgeBaseId: string,
): Promise<ActionResult<null>> {
  const userId = await requireUserId()

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
    columns: { id: true, ownerId: true },
  })
  if (!doc || doc.ownerId !== userId) {
    return { ok: false, error: 'Document not found.' }
  }

  const target = await ownedKnowledgeBaseId(userId, knowledgeBaseId)
  if (!target) return { ok: false, error: 'Knowledge base not found.' }

  // Both tables, always together. `chunks.knowledgeBaseId` is denormalised, so
  // updating only `documents` would leave retrieval filtering on a stale value
  // — the document would appear in its new KB and be searchable only from its
  // old one, which is exactly the silent inconsistency this column risks.
  await db.transaction(async (tx) => {
    await tx
      .update(documents)
      .set({ knowledgeBaseId: target })
      .where(eq(documents.id, doc.id))
    await tx
      .update(chunks)
      .set({ knowledgeBaseId: target })
      .where(eq(chunks.documentId, doc.id))
  })

  logger.info('Document moved', { userId, documentId, knowledgeBaseId: target })
  return { ok: true, data: null }
}
