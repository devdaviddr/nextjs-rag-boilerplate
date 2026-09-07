import 'server-only'

import { and, asc, eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { chunks, documents } from '@/db/schema'
import { env } from '@/lib/env'
import { embedQuery } from './embed'

/**
 * Owner-scoped nearest-neighbour retrieval (spec 0025 FR9, NFR1).
 *
 * Tenant isolation is enforced in the WHERE clause, not by filtering results
 * afterwards and not by asking the model to behave. `ownerId` is denormalised
 * onto `chunks` precisely so this query needs no join — a join is one
 * refactor away from being dropped, and the failure would be silent and
 * catastrophic.
 */

export interface RetrievedChunk {
  chunkId: string
  documentId: string
  documentTitle: string
  content: string
  pageNumber: number
  similarity: number
}

// `db.execute<T>` constrains T to Record<string, unknown>.
interface Row extends Record<string, unknown> {
  chunk_id: string
  document_id: string
  document_title: string
  content: string
  page_number: number
  similarity: number
}

/** pgvector's text representation of a vector literal. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

export async function retrieveForOwner(
  ownerId: string,
  question: string,
  options: { topK?: number; minSimilarity?: number } = {},
): Promise<RetrievedChunk[]> {
  const topK = options.topK ?? env.RAG_TOP_K
  const minSimilarity = options.minSimilarity ?? env.RAG_MIN_SIMILARITY

  const queryVector = toVectorLiteral(await embedQuery(question))

  // `<=>` is cosine distance under halfvec_cosine_ops, so similarity is
  // 1 - distance. Ordering by the raw distance is what lets the HNSW index be
  // used; ordering by the derived similarity would not.
  const rows = await db.execute<Row>(sql`
    SELECT
      c.id            AS chunk_id,
      c.document_id   AS document_id,
      d.title         AS document_title,
      c.content       AS content,
      c.page_number   AS page_number,
      1 - (c.embedding <=> ${queryVector}::halfvec) AS similarity
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.owner_id = ${ownerId}
    ORDER BY c.embedding <=> ${queryVector}::halfvec
    LIMIT ${topK}
  `)

  return Array.from(rows)
    .map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      documentTitle: r.document_title,
      content: r.content,
      pageNumber: Number(r.page_number),
      similarity: Number(r.similarity),
    }))
    .filter((r) => r.similarity >= minSimilarity)
}

/** The caller's indexed documents, for query scoping. */
export async function listReadyDocuments(
  ownerId: string,
): Promise<Array<{ id: string; title: string }>> {
  return db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.ownerId, ownerId), eq(documents.status, 'ready')))
}

/**
 * Retrieve a whole document in reading order, for summarise/overview requests
 * that similarity search structurally cannot serve (see scope.ts).
 *
 * Owner-scoped exactly as the kNN path is — the `ownerId` predicate is on
 * `chunks`, not inferred from the document, so this cannot become a way to
 * read someone else's file by guessing an id.
 */
export async function retrieveDocumentChunks(
  ownerId: string,
  documentId: string,
  limit: number,
): Promise<RetrievedChunk[]> {
  const rows = await db
    .select({
      chunkId: chunks.id,
      documentId: chunks.documentId,
      documentTitle: documents.title,
      content: chunks.content,
      pageNumber: chunks.pageNumber,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(and(eq(chunks.ownerId, ownerId), eq(chunks.documentId, documentId)))
    .orderBy(asc(chunks.chunkIndex))
    .limit(limit)

  // Similarity is not meaningful here — the whole document was requested, not
  // the passages nearest a query. Reported as 1 so the citation shape is
  // identical for the UI.
  return rows.map((r) => ({ ...r, similarity: 1 }))
}
