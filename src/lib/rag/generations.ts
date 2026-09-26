import 'server-only'

import { TTL_MS, activeEmbedding, refreshAiSettings } from '@/lib/ai-settings'
import { logger } from '@/lib/logger'

import { buildEmbeddingText } from './chunk'
import { createEmbeddings } from './client'
import { embedPassages } from './embed'
import { MAX_INDEXED_DIMENSIONS } from './generation-sql'

/**
 * Switching the embedding model (spec 0040 FR3, #56).
 *
 * A switch builds a new generation next to the active one: every chunk is
 * re-embedded with the new model into `chunk_embeddings`, its index is
 * built, and only then does it become active, in one transaction. Search
 * keeps using the old generation throughout, so answers never mix two
 * models' vectors. The chunks themselves, their text and their pages are
 * never touched.
 *
 * The build is resumable in the same way ingestion is (spec 0034): a worker
 * holds a lease on the generation and renews it every batch, and the
 * background sweep started by `src/instrumentation.ts` picks up a build whose
 * worker went away. A batch that fails records its error for Settings and is
 * retried by the next sweep.
 *
 * The retired generation is deleted a while after the swap, not at once:
 * other instances keep searching it until their settings next refresh.
 */

/** Chunks embedded per batch, and per lease renewal. */
export const BUILD_BATCH = 64

/** A lease older than this belongs to a worker that went away. */
export const BUILD_CLAIM_WINDOW_MS = 120_000

/** How long a retired generation stays searchable after a swap. */
export const RETIRED_GRACE_MS = TTL_MS * 4

async function store() {
  return import('./generations-store')
}

export type StartResult =
  | { ok: true; generationId: string; dimensions: number; totalChunks: number }
  | { ok: false; error: string }

/**
 * Start building a generation for `model`. Checks first that the model
 * answers and that its vectors fit an index (at most 4000 dimensions).
 * The caller runs `buildGeneration` in the background.
 */
export async function startGeneration(
  model: string,
  userId: string | null,
): Promise<StartResult> {
  const name = model.trim()
  if (!name) return { ok: false, error: 'Choose a model' }
  await refreshAiSettings({ force: true })
  if (name === activeEmbedding().model) {
    return { ok: false, error: `${name} is already the embedding model` }
  }

  let dimensions: number
  try {
    const [vector] = await createEmbeddings(
      ['A test passage.'],
      'passage',
      undefined,
      name,
    )
    dimensions = vector?.length ?? 0
  } catch (error) {
    return {
      ok: false,
      error: `${name} did not return an embedding: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (dimensions < 1 || dimensions > MAX_INDEXED_DIMENSIONS) {
    return {
      ok: false,
      error: `${name} returns ${dimensions}-dimensional vectors; the index takes 1 to ${MAX_INDEXED_DIMENSIONS}.`,
    }
  }

  const s = await store()
  const totalChunks = await s.countChunks()
  const generationId = await s.insertBuilding({
    model: name,
    dimensions,
    totalChunks,
    createdBy: userId,
  })
  if (!generationId) {
    return {
      ok: false,
      error: 'A re-index is already running. Cancel it first, or wait.',
    }
  }
  logger.info('Embedding re-index started', {
    generationId,
    model: name,
    dimensions,
    totalChunks,
  })
  return { ok: true, generationId, dimensions, totalChunks }
}

/**
 * Embed every chunk into a building generation, then make it active. Safe to
 * call from several places: only the worker holding the lease does anything.
 */
export async function buildGeneration(generationId: string): Promise<void> {
  const s = await store()
  if (!(await s.claimBuilding(generationId, BUILD_CLAIM_WINDOW_MS))) return

  const generation = (await s.readGenerations()).find(
    (g) => g.id === generationId,
  )
  if (!generation?.model) {
    await s.releaseBuilding(generationId, 'This generation has no model')
    return
  }
  const target = { model: generation.model, dimensions: generation.dimensions }

  try {
    for (;;) {
      const batch = await s.nextMissing(generationId, BUILD_BATCH)
      if (batch.length === 0) {
        await s.createIndex(generationId, target.dimensions)
        if (await s.activate(generationId)) break
        // Chunks were added since the last batch: embed those too.
        continue
      }
      const vectors = await embedPassages(
        batch.map((c) =>
          buildEmbeddingText({
            documentTitle: c.documentTitle,
            heading: c.heading,
            caption: c.caption,
            content: c.content,
          }),
        ),
        target,
      )
      await s.insertVectors(
        generationId,
        batch.map((c, i) => ({
          chunkId: c.chunkId,
          embedding: vectors[i] as number[],
        })),
      )
      const stillBuilding = await s.renewBuilding(generationId, {
        embeddedChunks: await s.countEmbedded(generationId),
        totalChunks: Math.max(generation.totalChunks, await s.countChunks()),
      })
      if (!stillBuilding) {
        logger.info('Embedding re-index cancelled', { generationId })
        return
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('Embedding re-index paused after an error; it will retry', {
      generationId,
      error: message,
    })
    await s.releaseBuilding(generationId, message)
    return
  }

  await refreshAiSettings({ force: true })
  logger.info('Embedding re-index finished; the new model is now in use', {
    generationId,
    model: target.model,
    dimensions: target.dimensions,
  })
}

/** Stop a build and remove what it embedded. Search is not affected. */
export async function cancelGeneration(generationId: string): Promise<void> {
  const s = await store()
  const generation = (await s.readGenerations()).find(
    (g) => g.id === generationId && g.status === 'building',
  )
  if (generation) await s.deleteGenerations([generationId])
}

/**
 * The background part (run by the ingestion recovery sweep): resume a build
 * whose worker went away, and delete retired generations once every instance
 * has had time to move off them.
 */
export async function sweepGenerations(): Promise<void> {
  const s = await store()
  const generations = await s.readGenerations()
  const active = generations.find((g) => g.status === 'active')
  const retired = generations.filter((g) => g.status === 'retired')
  if (
    retired.length > 0 &&
    active?.activatedAt &&
    Date.now() - active.activatedAt.getTime() > RETIRED_GRACE_MS
  ) {
    await s.deleteGenerations(retired.map((g) => g.id))
    logger.info('Deleted retired embedding generations', {
      generations: retired.map((g) => g.id),
    })
  }
  const building = generations.find((g) => g.status === 'building')
  if (building) await buildGeneration(building.id)
}

/** What Settings shows about the embedding index (#56). */
export interface ReindexView {
  activeModel: string
  activeDimensions: number
  building: {
    id: string
    model: string
    dimensions: number
    embeddedChunks: number
    totalChunks: number
    error: string | null
  } | null
}

export async function reindexView(): Promise<ReindexView> {
  const s = await store()
  const building = (await s.readGenerations()).find(
    (g) => g.status === 'building',
  )
  const active = activeEmbedding()
  return {
    activeModel: active.model,
    activeDimensions: active.dimensions,
    building: building
      ? {
          id: building.id,
          model: building.model ?? '',
          dimensions: building.dimensions,
          embeddedChunks: building.embeddedChunks,
          totalChunks: building.totalChunks,
          error: building.error,
        }
      : null,
  }
}
