'use server'

import { and, asc, count, countDistinct, desc, eq, sql } from 'drizzle-orm'
import { after } from 'next/server'
import { headers } from 'next/headers'

import { db } from '@/db'
import { chunks, documents, files, knowledgeBases } from '@/db/schema'
import type { DocumentStatus, ExtractionSummary } from '@/db/schema'
import { getCurrentSession } from '@/lib/auth/session'
import { env } from '@/lib/env'
import { toCitationBoxes } from '@/lib/citations/boxes'
import { logger } from '@/lib/logger'
import { type InspectedDocument, buildInspection } from './inspect'
import { UPLOAD_LIMITS, rateLimit } from '@/lib/rate-limit'
import { clientIpFromHeaders } from '@/lib/request-ip'
import { deleteObject, putObject } from '@/lib/storage/client'
import type { ActionResult } from '@/lib/storage/actions'
import { buildBucketKey, validateUpload } from '@/lib/storage/validation'
import { isRagConfigured } from './client'
import { DOCUMENT_MIME_TYPES } from './constants'
import { ingestDocument } from './ingest'

export interface DocumentSummary {
  id: string
  title: string
  status: DocumentStatus
  pageCount: number | null
  chunkCount: number
  error: string | null
  createdAt: Date
  /**
   * Some of this document is not searchable (spec 0037 FR7).
   *
   * On the SUMMARY rather than only in the detail view, because the list is
   * what everyone reads. A `Ready` badge that means both "fully indexed" and
   * "indexed except pages 7 and 8" makes the detail view a page nobody thinks
   * to open. Derived from the recorded outcomes, never stored — a second
   * source of truth would drift from the one written at ingestion.
   */
  partiallyIndexed: boolean
}

async function requireUserId(): Promise<string> {
  const session = await getCurrentSession()
  if (!session?.user.id) {
    throw new Error('You must be signed in.')
  }
  return session.user.id
}

async function currentUsageBytes(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${files.sizeBytes}), 0)` })
    .from(files)
    .where(eq(files.ownerId, userId))
  return Number(row?.total ?? 0)
}

/** Whether document chat is usable at all — surfaced in the UI as an empty state. */
export async function ragStatus(): Promise<{
  configured: boolean
  /**
   * Whether document cracking is on (spec 0031). The UI needs it because what
   * a user may upload changes: with it off a scanned PDF is refused, with it
   * on the same file is read. Copy that states one while the other is true is
   * worse than no copy.
   */
  cracking: boolean
}> {
  return { configured: isRagConfigured(), cracking: env.RAG_CRACK_ENABLED }
}

/**
 * Upload a PDF into the signed-in user's knowledge base.
 *
 * Reuses spec 0007's quota, rate limit and object storage wholesale; only the
 * MIME allow-list is narrowed. Ingestion is scheduled with `after()` so the
 * user gets an immediate response and watches `status` progress instead of
 * holding a request open for hundreds of embedding calls.
 */
export async function uploadDocument(
  formData: FormData,
): Promise<ActionResult<DocumentSummary>> {
  const userId = await requireUserId()

  if (!isRagConfigured()) {
    return {
      ok: false,
      error:
        'Document chat is not configured on this deployment (NVIDIA_API_KEY is unset).',
    }
  }

  const h = await headers()
  const limited = rateLimit(
    `rag-upload:${userId}:${clientIpFromHeaders(h)}`,
    UPLOAD_LIMITS.upload.limit,
    UPLOAD_LIMITS.upload.windowMs,
  )
  if (!limited.success) {
    return { ok: false, error: 'Too many uploads. Please wait a moment.' }
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return { ok: false, error: 'No file provided.' }
  }

  // A document lives in exactly one knowledge base, and the caller must say
  // which. Verified against this user before anything is written: Postgres
  // cannot express "document.owner must equal its KB's owner" without a
  // trigger, so that invariant is upheld here, on every write path that
  // assigns a KB (spec 0028).
  const knowledgeBaseId = formData.get('knowledgeBaseId')
  if (typeof knowledgeBaseId !== 'string' || !knowledgeBaseId) {
    return { ok: false, error: 'Choose a knowledge base to upload into.' }
  }
  const kb = await db.query.knowledgeBases.findFirst({
    where: eq(knowledgeBases.id, knowledgeBaseId),
    columns: { id: true, ownerId: true },
  })
  // Same response whether missing or someone else's — no existence signal.
  if (!kb || kb.ownerId !== userId) {
    return { ok: false, error: 'Knowledge base not found.' }
  }

  const mimeType = file.type || 'application/octet-stream'
  const usage = await currentUsageBytes(userId)
  const validation = validateUpload({ sizeBytes: file.size, mimeType }, usage, {
    allowedMimeTypes: DOCUMENT_MIME_TYPES,
  })
  if (!validation.ok) {
    return { ok: false, error: validation.error }
  }

  const bucketKey = buildBucketKey(userId, file.name)
  await putObject(bucketKey, Buffer.from(await file.arrayBuffer()), mimeType)

  const [fileRow] = await db
    .insert(files)
    .values({
      ownerId: userId,
      bucketKey,
      originalName: file.name,
      mimeType,
      sizeBytes: file.size,
    })
    .returning()
  if (!fileRow) throw new Error('Failed to record the uploaded file.')

  const [doc] = await db
    .insert(documents)
    .values({
      ownerId: userId,
      knowledgeBaseId: kb.id,
      fileId: fileRow.id,
      title: file.name.replace(/\.pdf$/i, ''),
      status: 'pending',
    })
    .returning()
  if (!doc) throw new Error('Failed to record the document.')

  logger.info('Document queued for ingestion', { userId, documentId: doc.id })
  after(async () => {
    await ingestDocument(doc.id)
  })

  return {
    ok: true,
    data: {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      pageCount: doc.pageCount,
      // Nothing has been recorded yet, so there is nothing to be partial about.
      partiallyIndexed: false,
      chunkCount: 0,
      error: doc.error,
      createdAt: doc.createdAt,
    },
  }
}

/**
 * List documents in one of the signed-in user's knowledge bases, newest first.
 *
 * `knowledgeBaseId` is required: there is no "all my documents" view any more,
 * because every listing surface is now reached through a specific KB.
 */
export async function listMyDocuments(
  knowledgeBaseId: string,
): Promise<DocumentSummary[]> {
  const userId = await requireUserId()

  // A correlated subquery written as a raw `sql` fragment does NOT work here:
  // Drizzle renders interpolated columns unqualified inside one, so
  // `WHERE ${chunks.documentId} = ${documents.id}` becomes
  // `WHERE "document_id" = "id"` — both resolving to the subquery's own FROM,
  // i.e. `chunks.document_id = chunks.id`. That is always false, so every
  // document silently reported zero chunks. A join keeps the qualification.
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      pageCount: documents.pageCount,
      error: documents.error,
      createdAt: documents.createdAt,
      extraction: documents.extraction,
      chunkCount: count(chunks.id),
      // FR7's third condition needs to know whether every recorded page
      // produced something, which the existing join can answer for free — no
      // extra query, and no shipping the whole extraction record to the client.
      indexedPages: countDistinct(chunks.pageNumber),
    })
    .from(documents)
    .leftJoin(chunks, eq(chunks.documentId, documents.id))
    .where(
      and(
        eq(documents.ownerId, userId),
        eq(documents.knowledgeBaseId, knowledgeBaseId),
      ),
    )
    .groupBy(documents.id)
    .orderBy(desc(documents.createdAt))

  return rows.map(({ extraction, indexedPages, ...r }) => ({
    ...r,
    status: r.status,
    chunkCount: Number(r.chunkCount),
    // The list gets the verdict, not the per-page record — that is what the
    // detail view is for, and shipping a document's whole ingestion history to
    // every row would put it on the index page for no one to read.
    partiallyIndexed: isPartiallyIndexed(extraction, Number(indexedPages)),
  }))
}

/**
 * FR7's verdict, from what the list already has.
 *
 * All three of the spec's conditions: the budget ran out, a page failed, or a
 * recorded page produced nothing. The third is the one `Ready` hides best —
 * it is the shape of the silent failure spec 0031 was written about — so it is
 * checked here and not left to a detail view nobody opens.
 *
 * `indexedPages` is a count of DISTINCT page numbers among the chunks, so
 * fewer of them than recorded pages means at least one page is not searchable.
 */
function isPartiallyIndexed(
  extraction: ExtractionSummary | null,
  indexedPages: number,
): boolean {
  // FR8: with no record there is no per-page truth to compare against, and
  // guessing from `pageCount` would flag every text-layer document that
  // legitimately merged pages into fewer chunks.
  if (!extraction) return false
  return (
    extraction.budgetExhausted ||
    extraction.pages.some((p) => p.outcome === 'failed') ||
    indexedPages < extraction.pages.length
  )
}

/**
 * Everything ingestion recorded about one document (spec 0037).
 *
 * Owner-scoped in the WHERE clause, and a document belonging to someone else
 * returns the same `null` as one that does not exist. This resolves a
 * caller-supplied id and returns the document's FULL indexed text, which makes
 * it the same shape of hazard as `retrieveDocumentChunks` — read its comment.
 */
export async function inspectDocument(documentId: string): Promise<{
  title: string
  status: DocumentStatus
  pageCount: number | null
  knowledgeBaseId: string | null
  inspection: InspectedDocument
} | null> {
  const userId = await requireUserId()

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, documentId), eq(documents.ownerId, userId)),
    columns: {
      title: true,
      status: true,
      pageCount: true,
      knowledgeBaseId: true,
      extraction: true,
    },
  })
  if (!doc) return null

  const rows = await db
    .select({
      id: chunks.id,
      kind: chunks.kind,
      content: chunks.content,
      tokenCount: chunks.tokenCount,
      pageNumber: chunks.pageNumber,
      boxes: chunks.boxes,
      bbox: chunks.bbox,
    })
    .from(chunks)
    .where(and(eq(chunks.documentId, documentId), eq(chunks.ownerId, userId)))
    .orderBy(asc(chunks.chunkIndex))

  return {
    title: doc.title,
    status: doc.status,
    pageCount: doc.pageCount,
    knowledgeBaseId: doc.knowledgeBaseId,
    inspection: buildInspection({
      pageCount: doc.pageCount,
      extraction: doc.extraction ?? null,
      chunks: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        content: r.content,
        tokenCount: r.tokenCount,
        pageNumber: r.pageNumber,
        // One reader reconciles the list with the legacy rectangle, so the
        // view never has to know which column a row was written with.
        boxes: toCitationBoxes(r.boxes as unknown, r.bbox as unknown),
      })),
    }),
  }
}

/**
 * Delete a document, its chunks, its `files` row and its stored object.
 *
 * Chunks cascade at the database level; the S3 object never does, so it is
 * removed explicitly — the same rule spec 0007 established.
 */
export async function deleteDocument(
  documentId: string,
): Promise<ActionResult<null>> {
  const userId = await requireUserId()

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  })
  // Same response whether missing or someone else's — no existence signal.
  if (!doc || doc.ownerId !== userId) {
    return { ok: false, error: 'Document not found.' }
  }

  const file = await db.query.files.findFirst({
    where: eq(files.id, doc.fileId),
    columns: { bucketKey: true },
  })

  await db.delete(documents).where(eq(documents.id, documentId))
  if (file) {
    await deleteObject(file.bucketKey)
    await db.delete(files).where(eq(files.id, doc.fileId))
  }

  logger.info('Document deleted', { userId, documentId })
  return { ok: true, data: null }
}

/** Re-run ingestion for a failed document. Idempotent — see ingest.ts. */
export async function retryDocument(
  documentId: string,
): Promise<ActionResult<null>> {
  const userId = await requireUserId()

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  })
  if (!doc || doc.ownerId !== userId) {
    return { ok: false, error: 'Document not found.' }
  }
  if (doc.status === 'extracting' || doc.status === 'embedding') {
    return { ok: false, error: 'This document is already being processed.' }
  }

  await db
    .update(documents)
    .set({ status: 'pending', error: null })
    .where(eq(documents.id, documentId))

  after(async () => {
    await ingestDocument(documentId)
  })

  return { ok: true, data: null }
}
