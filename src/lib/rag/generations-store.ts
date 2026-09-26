import 'server-only'

import { and, asc, count, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'

import { db } from '@/db'
import {
  chunkEmbeddings,
  chunks,
  documents,
  embeddingGenerations,
  type EmbeddingGenerationStatus,
} from '@/db/schema'

import { createGenerationIndex, dropGenerationIndex } from './generation-sql'

/**
 * The database side of embedding generations (#56), and nothing else. Kept
 * apart from `generations.ts` so its logic is tested with this replaced.
 */

export interface GenerationRow {
  id: string
  model: string | null
  dimensions: number
  status: EmbeddingGenerationStatus
  totalChunks: number
  embeddedChunks: number
  error: string | null
  claimedAt: Date | null
  activatedAt: Date | null
  createdAt: Date
}

export async function readGenerations(): Promise<GenerationRow[]> {
  return db
    .select({
      id: embeddingGenerations.id,
      model: embeddingGenerations.model,
      dimensions: embeddingGenerations.dimensions,
      status: embeddingGenerations.status,
      totalChunks: embeddingGenerations.totalChunks,
      embeddedChunks: embeddingGenerations.embeddedChunks,
      error: embeddingGenerations.error,
      claimedAt: embeddingGenerations.claimedAt,
      activatedAt: embeddingGenerations.activatedAt,
      createdAt: embeddingGenerations.createdAt,
    })
    .from(embeddingGenerations)
    .orderBy(asc(embeddingGenerations.createdAt))
}

export async function countChunks(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(chunks)
  return row?.n ?? 0
}

/** Insert a `building` generation; null when one is already building. */
export async function insertBuilding(values: {
  model: string
  dimensions: number
  totalChunks: number
  createdBy: string | null
}): Promise<string | null> {
  const rows = await db
    .insert(embeddingGenerations)
    .values({ ...values, status: 'building' })
    // The partial unique index allows one `building` row at a time.
    .onConflictDoNothing()
    .returning({ id: embeddingGenerations.id })
  return rows[0]?.id ?? null
}

/**
 * Take the lease on a building generation. Fails when another worker holds a
 * lease younger than `windowMs`, or the generation is no longer building.
 */
export async function claimBuilding(
  id: string,
  windowMs: number,
): Promise<boolean> {
  const rows = await db
    .update(embeddingGenerations)
    .set({ claimedAt: new Date(), error: null })
    .where(
      and(
        eq(embeddingGenerations.id, id),
        eq(embeddingGenerations.status, 'building'),
        or(
          isNull(embeddingGenerations.claimedAt),
          lt(embeddingGenerations.claimedAt, new Date(Date.now() - windowMs)),
        ),
      ),
    )
    .returning({ id: embeddingGenerations.id })
  return rows.length > 0
}

/** Renew the lease and record progress; false once cancelled. */
export async function renewBuilding(
  id: string,
  progress: { embeddedChunks: number; totalChunks: number },
): Promise<boolean> {
  const rows = await db
    .update(embeddingGenerations)
    .set({ claimedAt: new Date(), ...progress })
    .where(
      and(
        eq(embeddingGenerations.id, id),
        eq(embeddingGenerations.status, 'building'),
      ),
    )
    .returning({ id: embeddingGenerations.id })
  return rows.length > 0
}

/** Give the lease up, keeping the error for Settings; the sweep retries. */
export async function releaseBuilding(
  id: string,
  error: string | null,
): Promise<void> {
  await db
    .update(embeddingGenerations)
    .set({ claimedAt: null, error })
    .where(eq(embeddingGenerations.id, id))
}

export interface MissingChunk {
  chunkId: string
  ownerId: string
  knowledgeBaseId: string
  documentTitle: string
  heading: string | null
  caption: string | null
  content: string
}

/** Chunks that have no vector in this generation yet, oldest id first. */
export async function nextMissing(
  generationId: string,
  limit: number,
): Promise<MissingChunk[]> {
  return db
    .select({
      chunkId: chunks.id,
      ownerId: chunks.ownerId,
      knowledgeBaseId: chunks.knowledgeBaseId,
      documentTitle: documents.title,
      heading: chunks.heading,
      caption: chunks.caption,
      content: chunks.content,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .leftJoin(
      chunkEmbeddings,
      and(
        eq(chunkEmbeddings.chunkId, chunks.id),
        eq(chunkEmbeddings.generationId, generationId),
      ),
    )
    .where(isNull(chunkEmbeddings.chunkId))
    .orderBy(asc(chunks.id))
    .limit(limit)
}

/**
 * Store vectors for one batch. A chunk deleted since `nextMissing` is simply
 * skipped: the rows are inserted from a join on `chunks`, never blindly.
 */
export async function insertVectors(
  generationId: string,
  rows: { chunkId: string; embedding: number[] }[],
): Promise<void> {
  if (rows.length === 0) return
  const values = sql.join(
    rows.map(
      (r) => sql`(${r.chunkId}, ${`[${r.embedding.join(',')}]`}::halfvec)`,
    ),
    sql`, `,
  )
  await db.execute(sql`
    INSERT INTO chunk_embeddings (chunk_id, generation_id, owner_id, knowledge_base_id, embedding)
    SELECT c.id, ${generationId}, c.owner_id, c.knowledge_base_id, v.embedding
    FROM (VALUES ${values}) AS v (chunk_id, embedding)
    JOIN chunks c ON c.id = v.chunk_id
    ON CONFLICT DO NOTHING
  `)
}

export async function countEmbedded(generationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(chunkEmbeddings)
    .where(eq(chunkEmbeddings.generationId, generationId))
  return row?.n ?? 0
}

export async function createIndex(
  generationId: string,
  dimensions: number,
): Promise<void> {
  await db.execute(createGenerationIndex(generationId, dimensions))
}

/**
 * Make a finished generation the active one, in one transaction, but only if
 * every chunk has a vector in it. Returns false when chunks arrived since the
 * last batch: the builder embeds them and tries again.
 */
export async function activate(generationId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [missing] = await tx
      .select({ n: count() })
      .from(chunks)
      .leftJoin(
        chunkEmbeddings,
        and(
          eq(chunkEmbeddings.chunkId, chunks.id),
          eq(chunkEmbeddings.generationId, generationId),
        ),
      )
      .where(isNull(chunkEmbeddings.chunkId))
    if ((missing?.n ?? 0) > 0) return false
    await tx
      .update(embeddingGenerations)
      .set({ status: 'retired', claimedAt: null })
      .where(eq(embeddingGenerations.status, 'active'))
    const rows = await tx
      .update(embeddingGenerations)
      .set({ status: 'active', activatedAt: new Date(), claimedAt: null })
      .where(
        and(
          eq(embeddingGenerations.id, generationId),
          eq(embeddingGenerations.status, 'building'),
        ),
      )
      .returning({ id: embeddingGenerations.id })
    if (rows.length === 0) throw new Error('Generation is no longer building')
    return true
  })
}

/** Remove generations and their vectors and indexes. Never the active one. */
export async function deleteGenerations(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  for (const id of ids) await db.execute(dropGenerationIndex(id))
  await db
    .delete(embeddingGenerations)
    .where(
      and(
        inArray(embeddingGenerations.id, ids),
        inArray(embeddingGenerations.status, ['building', 'retired']),
      ),
    )
}
