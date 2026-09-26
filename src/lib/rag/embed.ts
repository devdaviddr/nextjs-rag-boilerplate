import 'server-only'

import { activeEmbedding, aiSettings } from '@/lib/ai-settings'
import { createEmbeddings } from './client'

/**
 * Embedding with the passage/query distinction made structural.
 *
 * There is deliberately NO general-purpose `embed()` export. The model is
 * asymmetric — the same sentence embedded both ways is only ~0.785 similar —
 * so a single function with a defaulted `inputType` would let a call site pick
 * the wrong one and degrade retrieval with no visible error. Two named
 * functions make the choice impossible to omit.
 */

function assertDimensions(vectors: number[][], expected: number): void {
  for (const vector of vectors) {
    if (vector.length !== expected) {
      // Vectors of another size are not comparable with the generation's
      // index, and would fail its cast; say so here instead (#56).
      throw new Error(
        `Embedding model returned ${vector.length} dimensions, expected ${expected}. ` +
          'Change the embedding model from Settings, which re-indexes every document.',
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
export async function embedPassages(
  texts: string[],
  /** Another generation's model and size; the active one's by default (#56). */
  target: { model: string; dimensions: number } = activeEmbedding(),
): Promise<number[][]> {
  if (texts.length === 0) return []

  const batches = batched(texts, aiSettings().RAG_EMBED_BATCH)
  const results = await pooled(
    batches,
    aiSettings().RAG_EMBED_CONCURRENCY,
    (batch) => createEmbeddings(batch, 'passage', undefined, target.model),
  )

  const vectors = results.flat()
  assertDimensions(vectors, target.dimensions)
  return vectors
}

/** Embed a single search query. Never use this for document text. */
export async function embedQuery(
  text: string,
  signal?: AbortSignal,
  /** The generation the caller will search, read once by the caller (#56). */
  active: { model: string; dimensions: number } = activeEmbedding(),
): Promise<number[]> {
  const [vector] = await createEmbeddings([text], 'query', signal, active.model)
  if (!vector) throw new Error('Embedding model returned no vector for query.')
  assertDimensions([vector], active.dimensions)
  return vector
}
