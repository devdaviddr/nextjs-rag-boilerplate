import 'server-only'

import { env } from '@/lib/env'
import { createEmbeddings } from './client'
import { EMBEDDING_DIMENSIONS } from './constants'

/**
 * Embedding with the passage/query distinction made structural.
 *
 * There is deliberately NO general-purpose `embed()` export. The model is
 * asymmetric — the same sentence embedded both ways is only ~0.785 similar —
 * so a single function with a defaulted `inputType` would let a call site pick
 * the wrong one and degrade retrieval with no visible error. Two named
 * functions make the choice impossible to omit.
 */

function assertDimensions(vectors: number[][]): void {
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      // The schema column is halfvec(2048); a mismatch would fail at INSERT
      // with an opaque driver error, so fail here with a useful one.
      throw new Error(
        `Embedding model returned ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. ` +
          'RAG_EMBED_MODEL does not match the chunks.embedding column — a migration is required.',
      )
    }
  }
}

/** Run tasks with bounded concurrency, preserving input order. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (true) {
        const index = cursor++
        if (index >= items.length) return
        const item = items[index]
        if (item === undefined) continue
        results[index] = await worker(item, index)
      }
    })(),
  )

  await Promise.all(runners)
  return results
}

function batched<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches
}

/**
 * Embed document chunks. Batched and pooled because a 200-page PDF is
 * hundreds of calls against a rate-limited free tier — the client retries a
 * 429, but staying under it is cheaper than backing off.
 */
export async function embedPassages(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  const batches = batched(texts, env.RAG_EMBED_BATCH)
  const results = await pooled(batches, env.RAG_EMBED_CONCURRENCY, (batch) =>
    createEmbeddings(batch, 'passage'),
  )

  const vectors = results.flat()
  assertDimensions(vectors)
  return vectors
}

/** Embed a single search query. Never use this for document text. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await createEmbeddings([text], 'query')
  if (!vector) throw new Error('Embedding model returned no vector for query.')
  assertDimensions([vector])
  return vector
}
