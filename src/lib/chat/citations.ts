import type { StoredCitation } from '@/db/schema'
import type { RetrievedChunk } from '@/lib/rag/retrieve'

/**
 * The citations an answer stores, one per retrieved source, numbered from 1
 * in retrieval order so `[n]` in the answer points at `citations[n - 1]`.
 *
 * An assembled section PARENT (spec 0033, 1c) is marked `parent: true`. The
 * citation panel reads that flag and asks the citations route for the whole
 * run's boxes. Without it the panel falls back to the run's FIRST chunk, which
 * is often not a chunk the gate admitted at all, so the highlight lands on the
 * wrong paragraph. Pure and outside the route so that link is pinned by a test.
 */
export function toStoredCitations(
  retrieved: readonly RetrievedChunk[],
): StoredCitation[] {
  return retrieved.map((chunk, i) => ({
    index: i + 1,
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    pageNumber: chunk.pageNumber,
    similarity: Number(chunk.similarity.toFixed(4)),
    ...(chunk.memberChunkIds?.length ? { parent: true as const } : {}),
  }))
}
