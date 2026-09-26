import { type SQL, sql } from 'drizzle-orm'

/**
 * Pieces of SQL for one embedding generation (#56, #64), written into the
 * query as literals rather than bound as parameters.
 *
 * Each generation's HNSW index is partial (`WHERE generation_id = '<id>'`)
 * and on an expression (`embedding::halfvec(N)`). Postgres only uses a
 * partial index when it can prove the query's filter implies the index's
 * predicate while planning, and a bound parameter hides the value from a
 * generic plan: after a few executions of a prepared statement the planner
 * may switch to one and fall back to a sequential scan of every vector, with
 * nothing but latency to show for it. So the id and the size are literals,
 * and are validated strictly before they get there.
 */

const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

/** The most dimensions an HNSW index on `halfvec` accepts (pgvector). */
export const MAX_INDEXED_DIMENSIONS = 4000

export function assertGenerationId(id: string): string {
  if (!GENERATION_ID.test(id)) {
    throw new Error(
      `Not a valid embedding generation id: ${JSON.stringify(id)}`,
    )
  }
  return id
}

export function assertDimensions(dimensions: number): number {
  if (
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > MAX_INDEXED_DIMENSIONS
  ) {
    throw new Error(
      `Embeddings must have 1 to ${MAX_INDEXED_DIMENSIONS} dimensions to be indexed; got ${dimensions}`,
    )
  }
  return dimensions
}

/** `'initial'` — the generation id as a quoted literal. */
export function generationLiteral(id: string): SQL {
  return sql.raw(`'${assertGenerationId(id)}'`)
}

/** `halfvec(2048)` — the type a generation's vectors are compared as. */
export function halfvecType(dimensions: number): SQL {
  return sql.raw(`halfvec(${assertDimensions(dimensions)})`)
}

/** The index name for a generation. */
export function generationIndexName(id: string): string {
  return `chunk_embeddings_${assertGenerationId(id).replace(/-/g, '_')}_hnsw_idx`
}

/** `CREATE INDEX` for a generation's own rows at its own size. */
export function createGenerationIndex(id: string, dimensions: number): SQL {
  return sql.raw(
    `CREATE INDEX IF NOT EXISTS "${generationIndexName(id)}" ON "chunk_embeddings" ` +
      `USING hnsw (("embedding"::halfvec(${assertDimensions(dimensions)})) halfvec_cosine_ops) ` +
      `WHERE "generation_id" = '${assertGenerationId(id)}'`,
  )
}

export function dropGenerationIndex(id: string): SQL {
  return sql.raw(`DROP INDEX IF EXISTS "${generationIndexName(id)}"`)
}
