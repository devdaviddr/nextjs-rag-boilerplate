import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { chunks as chunksTable, documents, files } from '@/db/schema'
import type { DocumentStatus, ExtractionSummary } from '@/db/schema'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { getObjectBuffer } from '@/lib/storage/client'
import { buildEmbeddingText } from './chunk'
import { chunksFromPdf } from './crack'
import { embedPassages } from './embed'
import { ExtractionError } from './extract'

/**
 * The ingestion state machine (spec 0025 FR4).
 *
 *   pending -> extracting -> embedding -> ready
 *                        \-> failed (with a user-readable reason)
 *
 * Runs out-of-band from the request that triggered it: a 200-page PDF is
 * hundreds of embedding calls against a rate-limited endpoint, which cannot
 * happen inside a Server Action. No queue and no worker container — the
 * boilerplate's deliberate "no queue" stance from spec 0007 still holds at
 * this scale, and `documents.status` is what the UI polls.
 */

async function setStatus(
  documentId: string,
  status: DocumentStatus,
  extra: {
    error?: string | null
    pageCount?: number
    pagesProcessed?: number
    extraction?: ExtractionSummary
  } = {},
): Promise<void> {
  await db
    .update(documents)
    .set({
      status,
      error: extra.error ?? null,
      ...(extra.pageCount !== undefined ? { pageCount: extra.pageCount } : {}),
      ...(extra.pagesProcessed !== undefined
        ? { pagesProcessed: extra.pagesProcessed }
        : {}),
      ...(extra.extraction !== undefined
        ? { extraction: extra.extraction }
        : {}),
    })
    .where(eq(documents.id, documentId))
}

/** Progress only — deliberately not routed through `setStatus`, which clears
 *  `error` on every write and would erase a failure mid-run (FR13). */
async function setPagesProcessed(
  documentId: string,
  pagesProcessed: number,
): Promise<void> {
  await db
    .update(documents)
    .set({ pagesProcessed })
    .where(eq(documents.id, documentId))
}

export async function ingestDocument(documentId: string): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  })
  if (!doc) {
    logger.warn('Ingestion skipped — document missing', { documentId })
    return
  }

  try {
    await setStatus(documentId, 'extracting')

    const file = await db.query.files.findFirst({
      where: eq(files.id, doc.fileId),
      columns: { bucketKey: true },
    })
    if (!file)
      throw new ExtractionError('The uploaded file is no longer available.')

    const buffer = await getObjectBuffer(file.bucketKey)
    const {
      chunks: pieces,
      pageCount,
      extraction,
    } = await chunksFromPdf(buffer, {
      chunkTokens: env.RAG_CHUNK_TOKENS,
      overlapTokens: env.RAG_CHUNK_OVERLAP_TOKENS,
      onPageProcessed: (processed) => setPagesProcessed(documentId, processed),
    })

    if (pieces.length === 0) {
      throw new ExtractionError(
        'No readable text could be extracted from this PDF.',
      )
    }

    await setStatus(documentId, 'embedding', { pageCount, extraction })

    // Embed the composed text (title + heading + content), store the original.
    // A citation must show the document's own words, not this preamble.
    const vectors = await embedPassages(
      pieces.map((piece) =>
        buildEmbeddingText({
          documentTitle: doc.title,
          heading: piece.heading,
          caption: piece.caption,
          content: piece.content,
        }),
      ),
    )

    // Delete-then-insert inside one transaction makes re-ingesting a failed
    // document idempotent — a retry can never double up chunks (NFR5).
    await db.transaction(async (tx) => {
      await tx.delete(chunksTable).where(eq(chunksTable.documentId, documentId))
      await tx.insert(chunksTable).values(
        pieces.map((piece, i) => ({
          documentId,
          ownerId: doc.ownerId,
          // Denormalised from the document, never from the session: a chunk's
          // KB must always be its document's KB, or retrieval filters on a
          // value the document itself disagrees with.
          knowledgeBaseId: doc.knowledgeBaseId,
          content: piece.content,
          heading: piece.heading,
          pageNumber: piece.pageNumber,
          chunkIndex: piece.chunkIndex,
          tokenCount: piece.tokenCount,
          // 'text' when the text-layer path produced this chunk, which is
          // also the column default — so nothing about an uncracked document
          // changes shape.
          kind: piece.kind ?? 'text',
          bbox: piece.bbox ?? null,
          embedding: vectors[i] as number[],
        })),
      )
    })

    await setStatus(documentId, 'ready', {
      pageCount,
      pagesProcessed: pageCount,
      extraction,
    })
    logger.info('Document ingested', {
      documentId,
      pageCount,
      chunkCount: pieces.length,
      parseCalls: extraction?.parseCalls ?? 0,
      budgetExhausted: extraction?.budgetExhausted ?? false,
    })
  } catch (error) {
    // ExtractionError messages are written for the user and are safe to show.
    // Anything else could carry internals, so it is logged and generalised.
    const isExpected = error instanceof ExtractionError
    const message = isExpected
      ? error.message
      : 'Processing failed. Please try again, or remove and re-upload this document.'

    if (!isExpected) {
      logger.error('Document ingestion failed', {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    await setStatus(documentId, 'failed', { error: message })
  }
}
