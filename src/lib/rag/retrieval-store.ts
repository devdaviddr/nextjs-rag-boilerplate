import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import type { ChunkKind } from '@/db/schema'
import { generationLiteral, halfvecType } from './generation-sql'
import type { PageRow } from './parents'
import type {
  DocumentOutlineRow,
  RetrievedChunk,
  ScopableDocument,
} from './retrieve'

/**
 * Every SQL statement retrieval runs (#146), and nothing else.
 *
 * `retrieve.ts` decides WHAT to fetch — the pool size, the rerank, the gate,
 * parent assembly, document sampling. This module decides HOW: Postgres,
 * pgvector and full-text search. A fork that wants another store replaces
 * this file's functions and keeps the rest.
 *
 * Every query is owner- AND knowledge-base-scoped in its own WHERE clause
 * (spec 0025 NFR1, spec 0028). Whatever replaces this file must keep that:
 * the tenant boundary is enforced here, not trusted to callers.
 */

// `db.execute<T>` constrains T to Record<string, unknown>.
interface Row extends Record<string, unknown> {
  chunk_id: string
  document_id: string
  document_title: string
  mime_type: string | null
  content: string
  page_number: number
  kind: ChunkKind
  heading: string | null
  heading_bbox: unknown
  similarity: number
  lexical_rank: number
  vec_rank: number | null
  lex_rank_pos: number | null
}

interface ParentPageRowRaw extends Record<string, unknown> {
  id: string
  content: string
  heading: string | null
  heading_bbox: unknown
  kind: ChunkKind
  chunk_index: number
  token_count: number
  page_number: number
  document_id: string
}

interface DocumentChunkRow extends Record<string, unknown> {
  chunk_id: string
  document_id: string
  document_title: string
  mime_type: string | null
  content: string
  page_number: number
  kind: ChunkKind
}

interface ReadyDocumentRow extends Record<string, unknown> {
  id: string
  title: string
}

/** pgvector's text representation of a vector literal. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

/**
 * Render a knowledge-base id list as a Postgres ARRAY literal for `= ANY(...)`.
 *
 * Drizzle's `sql` template does not turn a JS array interpolated directly
 * into a Postgres array parameter — it renders as a parenthesised tuple
 * (`($2, $3)::text[]`), which is not a valid array cast. Building the
 * `ARRAY[...]` constructor explicitly, with one bound parameter per id via
 * `sql.join`, is the form that actually parameterises correctly and is what
 * every `= ANY(...)` predicate below uses. Never called with an empty list —
 * every caller short-circuits on an empty selection before reaching here.
 */
function kbIdArray(knowledgeBaseIds: readonly string[]) {
  return sql`ARRAY[${sql.join(
    knowledgeBaseIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`
}

/**
 * A non-PDF document's chunks are sections, not pages (spec 0046 FR7).
 * Only present then, so a PDF chunk is the shape it always was.
 */
function sectionUnit(mimeType: string | null): { unit?: 'section' } {
  return mimeType && mimeType !== 'application/pdf' ? { unit: 'section' } : {}
}

/** The hybrid search's inputs; see `retrieveForOwner` for how each is chosen. */
export interface HybridSearch {
  ownerId: string
  knowledgeBaseIds: readonly string[]
  question: string
  /** The question's embedding, as `toVectorLiteral` renders it. */
  queryVector: string
  generationId: string
  dimensions: number
  /** Rows each channel contributes before fusion. */
  candidates: number
  /** Fused rows returned. */
  poolSize: number
  /** Reciprocal Rank Fusion's k. */
  rrfK: number
}

/**
 * Hybrid retrieval (spec 0027, 1b): a dense channel and a lexical one, fused
 * with Reciprocal Rank Fusion, best first.
 */
export async function searchHybrid(q: HybridSearch): Promise<RetrievedChunk[]> {
  const {
    ownerId,
    knowledgeBaseIds,
    question,
    queryVector,
    candidates,
    poolSize,
    rrfK,
  } = q
  // The generation's id and size go in as literals so its partial index is
  // always usable (see generation-sql.ts).
  const generation = generationLiteral(q.generationId)
  const vecType = halfvecType(q.dimensions)
  const rows = await db.execute<Row>(sql`
    WITH q AS (
      -- The lexical query is an OR of the question's lexemes, not an AND.
      --
      -- websearch_to_tsquery ANDs its terms, which is wrong for a question:
      -- "What does POL-HR-014 cover?" becomes
      --   'pol-hr' <-> 'pol' <-> 'hr' <-> '014' & 'cover'
      -- and the passage containing the identifier is rejected because it does
      -- not also contain "cover". Questions are full of verbs and filler that
      -- never appear in the passage that answers them.
      --
      -- OR-ing is permissive by design; ts_rank_cd then does the discriminating,
      -- and the lexical floor below decides what is strong enough to admit.
      SELECT to_tsquery(
               'english',
               NULLIF(string_agg(quote_literal(lexeme), ' | '), '')
             ) AS query
      FROM unnest(to_tsvector('english', ${question}))
    ),
    vec AS (
      SELECT e.chunk_id AS id,
             ROW_NUMBER() OVER (ORDER BY e.embedding::${vecType} <=> ${queryVector}::${vecType}) AS pos
      FROM chunk_embeddings e
      WHERE e.generation_id = ${generation}
        AND e.owner_id = ${ownerId}
        AND e.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
      ORDER BY e.embedding::${vecType} <=> ${queryVector}::${vecType}
      LIMIT ${candidates}
    ),
    lex AS (
      SELECT c.id,
             ts_rank_cd(c.content_tsv, q.query) AS rank,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.content_tsv, q.query) DESC) AS pos
      FROM chunks c CROSS JOIN q
      WHERE c.owner_id = ${ownerId}
        AND c.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
        AND q.query IS NOT NULL
        AND c.content_tsv @@ q.query
      ORDER BY ts_rank_cd(c.content_tsv, q.query) DESC
      LIMIT ${candidates}
    ),
    fused AS (
      SELECT COALESCE(vec.id, lex.id) AS id,
             vec.pos AS vec_rank,
             lex.pos AS lex_rank_pos,
             COALESCE(lex.rank, 0) AS lexical_rank,
             COALESCE(1.0 / (${rrfK} + vec.pos), 0)
               + COALESCE(1.0 / (${rrfK} + lex.pos), 0) AS rrf
      FROM vec FULL OUTER JOIN lex ON vec.id = lex.id
    )
    SELECT
      c.id            AS chunk_id,
      c.document_id   AS document_id,
      d.title         AS document_title,
      fl.mime_type    AS mime_type,
      c.content       AS content,
      c.page_number   AS page_number,
      c.kind          AS kind,
      c.heading       AS heading,
      c.heading_bbox  AS heading_bbox,
      COALESCE(1 - (e.embedding::${vecType} <=> ${queryVector}::${vecType}), 0) AS similarity,
      f.lexical_rank  AS lexical_rank,
      f.vec_rank      AS vec_rank,
      f.lex_rank_pos  AS lex_rank_pos
    FROM fused f
    JOIN chunks c ON c.id = f.id
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN files fl ON fl.id = d.file_id
    LEFT JOIN chunk_embeddings e
      ON e.chunk_id = c.id AND e.generation_id = ${generation}
    WHERE c.owner_id = ${ownerId}
      AND c.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
    ORDER BY f.rrf DESC
    LIMIT ${poolSize}
  `)

  return Array.from(rows).map((r): RetrievedChunk => {
    const inVector = r.vec_rank !== null
    const inLexical = r.lex_rank_pos !== null
    return {
      chunkId: r.chunk_id,
      documentId: r.document_id,
      documentTitle: r.document_title,
      ...sectionUnit(r.mime_type),
      content: r.content,
      pageNumber: Number(r.page_number),
      kind: r.kind,
      similarity: Number(r.similarity),
      lexicalRank: Number(r.lexical_rank),
      source: (inVector && inLexical
        ? 'both'
        : inVector
          ? 'vector'
          : 'lexical') as RetrievedChunk['source'],
      // Only when present, so a heading-less chunk is byte-for-byte the shape
      // it was before parent assembly existed.
      ...(r.heading != null ? { heading: r.heading } : {}),
      ...(r.heading_bbox != null ? { headingBbox: r.heading_bbox } : {}),
    }
  })
}

/**
 * Every chunk on the given pages, in reading order, for parent assembly
 * (spec 0033, 1c). Scoped by owner and knowledge base like every query here,
 * never inferred from the chunk ids the caller holds.
 */
export async function loadSectionPages(
  ownerId: string,
  knowledgeBaseIds: readonly string[],
  pages: readonly { documentId: string; pageNumber: number }[],
): Promise<PageRow[]> {
  const rows = await db.execute<ParentPageRowRaw>(sql`
    SELECT c.id           AS id,
           c.content      AS content,
           c.heading      AS heading,
           c.heading_bbox AS heading_bbox,
           c.kind         AS kind,
           c.chunk_index  AS chunk_index,
           c.token_count  AS token_count,
           c.page_number  AS page_number,
           c.document_id  AS document_id
    FROM chunks c
    WHERE c.owner_id = ${ownerId}
      AND c.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
      AND (c.document_id, c.page_number) IN (${sql.join(
        pages.map((p) => sql`(${p.documentId}, ${p.pageNumber}::int)`),
        sql`, `,
      )})
    ORDER BY c.document_id, c.page_number, c.chunk_index
  `)

  return Array.from(rows).map((r) => ({
    id: r.id,
    documentId: r.document_id,
    pageNumber: Number(r.page_number),
    content: r.content,
    heading: r.heading,
    headingBbox: r.heading_bbox,
    kind: r.kind,
    chunkIndex: Number(r.chunk_index),
    tokenCount: Number(r.token_count),
  }))
}

/** The caller's indexed documents in the given knowledge bases. */
export async function readyDocuments(
  ownerId: string,
  knowledgeBaseIds: readonly string[],
): Promise<ScopableDocument[]> {
  const rows = await db.execute<ReadyDocumentRow>(sql`
    SELECT d.id AS id, d.title AS title
    FROM documents d
    WHERE d.owner_id = ${ownerId}
      AND d.status = 'ready'
      AND d.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
  `)
  return Array.from(rows).map((r) => ({ id: r.id, title: r.title }))
}

/** A document's chunks as ids and positions only, without their text (#99). */
export async function documentOutline(
  ownerId: string,
  documentId: string,
  knowledgeBaseIds: readonly string[],
): Promise<DocumentOutlineRow[]> {
  const outline = await db.execute<
    Record<string, unknown> & {
      id: string
      chunk_index: number
      page_number: number
      heading: string | null
    }
  >(sql`
    SELECT c.id AS id, c.chunk_index AS chunk_index,
           c.page_number AS page_number, c.heading AS heading
    FROM chunks c
    WHERE c.owner_id = ${ownerId}
      AND c.document_id = ${documentId}
      AND c.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
  `)
  return Array.from(outline).map((r) => ({
    id: r.id,
    chunkIndex: Number(r.chunk_index),
    pageNumber: Number(r.page_number),
    heading: r.heading,
  }))
}

/** The given chunks of a document, with their text, in reading order. */
export async function documentChunks(
  ownerId: string,
  documentId: string,
  knowledgeBaseIds: readonly string[],
  ids: readonly string[],
): Promise<RetrievedChunk[]> {
  const loaded = await db.execute<DocumentChunkRow>(sql`
    SELECT c.id            AS chunk_id,
           c.document_id   AS document_id,
           d.title         AS document_title,
           fl.mime_type    AS mime_type,
           c.content       AS content,
           c.page_number   AS page_number,
           c.kind          AS kind
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN files fl ON fl.id = d.file_id
    WHERE c.owner_id = ${ownerId}
      AND c.document_id = ${documentId}
      AND c.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
      AND c.id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    ORDER BY c.chunk_index ASC
  `)

  // Similarity is not meaningful here — the whole document was requested, not
  // the passages nearest a query. Reported as 1 so the citation shape is
  // identical for the UI.
  return Array.from(loaded).map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    documentTitle: r.document_title,
    ...sectionUnit(r.mime_type),
    content: r.content,
    pageNumber: Number(r.page_number),
    similarity: 1,
    kind: r.kind,
  }))
}
