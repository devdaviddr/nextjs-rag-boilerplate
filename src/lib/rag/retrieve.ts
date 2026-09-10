import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import type { ChunkKind } from '@/db/schema'
import { env } from '@/lib/env'
import { embedQuery } from './embed'

/**
 * Owner- and knowledge-base-scoped nearest-neighbour retrieval
 * (spec 0025 FR9, NFR1; spec 0028 FR6, NFR1-NFR3).
 *
 * Tenant isolation is enforced in the WHERE clause, not by filtering results
 * afterwards and not by asking the model to behave. `ownerId` is denormalised
 * onto `chunks` precisely so this query needs no join — a join is one
 * refactor away from being dropped, and the failure would be silent and
 * catastrophic.
 *
 * `knowledgeBaseId` is denormalised for exactly the same reason and gets
 * exactly the same treatment: `AND c.knowledge_base_id = ANY($kbIds)` sits
 * beside `owner_id` in every WHERE clause below — the dense CTE, the lexical
 * CTE and the final SELECT — never bolted on only at the end and never
 * reached via a join to `documents`.
 *
 * This is a WEAKER boundary than owner_id. It does not stop one user from
 * reaching another's data — owner_id already does that, unweakened. It stops
 * a conversation scoped to some of a user's own knowledge bases from reaching
 * the rest. That distinction matters because it is enforced identically in
 * code and must not be "simplified" later on the theory that same-owner data
 * is safe to relax — see `retrieveDocumentChunks` below for exactly how that
 * mistake looks in practice.
 */

export interface RetrievedChunk {
  chunkId: string
  documentId: string
  documentTitle: string
  content: string
  pageNumber: number
  /** Cosine similarity, always computed — even for lexical-only hits. */
  similarity: number
  /** `ts_rank_cd` for the lexical channel; 0 when the chunk did not match. */
  lexicalRank?: number
  /** Which channel(s) surfaced it. Useful in evaluation and debugging. */
  source?: 'vector' | 'lexical' | 'both'
  /**
   * What this chunk is (spec 0031). Carried through retrieval because a
   * `figure` chunk's content is a SEARCH KEY, not the document's words — the
   * planner needs to know it can look at the picture instead of quoting the
   * text, and a citation needs to know not to present it as a quotation.
   */
  kind?: ChunkKind
}

export interface RetrieveOptions {
  topK?: number
  minSimilarity?: number
}

/**
 * A document as handed to query scoping (`scope.ts`) — deliberately opaque
 * beyond id and title. Scoping never needs to know which knowledge base a
 * document is in; it only ever sees documents already filtered to the
 * permitted set, which is the whole point (spec 0028 — scope.ts needs no
 * code change because it takes an opaque, pre-filtered list).
 */
export interface ScopableDocument {
  id: string
  title: string
}

// `db.execute<T>` constrains T to Record<string, unknown>.
interface Row extends Record<string, unknown> {
  chunk_id: string
  document_id: string
  document_title: string
  content: string
  page_number: number
  kind: ChunkKind
  similarity: number
  lexical_rank: number
  vec_rank: number | null
  lex_rank_pos: number | null
}

interface DocumentChunkRow extends Record<string, unknown> {
  chunk_id: string
  document_id: string
  document_title: string
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

// Ceiling on the scaled candidate pool (see retrieveForOwner below). Without
// one, a user who selects dozens of knowledge bases at once would turn a
// single question into a scan sized for their whole account — the ceiling
// keeps the worst case bounded regardless of how many KBs get passed in.
const CANDIDATE_POOL_CEILING = 200

export async function retrieveForOwner(
  ownerId: string,
  question: string,
  knowledgeBaseIds: readonly string[],
  options: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  // An empty selection cannot produce a candidate row: `= ANY('{}')` matches
  // nothing, for any chunk. Short-circuit before embedQuery() rather than
  // spend a rate-limited embedding call to discover that (spec 0028 FR7,
  // NFR3). This is the only place an empty array changes control flow —
  // everywhere below, the predicate is still emitted and bound to whatever
  // was passed in, never omitted. A query that can silently run with no KB
  // predicate is the one failure mode this whole feature exists to prevent.
  if (knowledgeBaseIds.length === 0) return []

  const topK = options.topK ?? env.RAG_TOP_K
  const minSimilarity = options.minSimilarity ?? env.RAG_MIN_SIMILARITY
  const rrfK = env.RAG_RRF_K

  // Filtered-ANN caveat (docs/rag.md): pgvector applies the owner predicate
  // AFTER the HNSW scan, so a tenant holding a small share of all chunks can
  // already get fewer than topK results back at the existing owner-only
  // scope. A second narrowing predicate — KB membership — thins the same
  // fixed-size candidate pool further, and does so worse the fewer KBs are
  // selected out of however many the user has. This function has no cheap
  // way to see the user's total KB count, so the number of KBs actually
  // selected is the only signal available; scale the per-channel LIMIT by
  // it, capped so the worst case (many KBs selected at once) stays bounded.
  const candidates = Math.min(
    env.RAG_HYBRID_CANDIDATES * knowledgeBaseIds.length,
    CANDIDATE_POOL_CEILING,
  )

  const queryVector = toVectorLiteral(await embedQuery(question))

  // Hybrid retrieval (spec 0027, 1b): a dense channel and a lexical one, fused
  // with Reciprocal Rank Fusion.
  //
  // RRF combines ranks rather than scores, which matters because cosine
  // similarity and ts_rank_cd are not on comparable scales — normalising them
  // against each other is the fragile part of naive hybrid search, and RRF
  // sidesteps it entirely.
  //
  // Both channels are owner- AND knowledge-base-scoped in their own WHERE
  // clause, not only in the final SELECT — the CTEs' LIMIT $candidates pool
  // would otherwise be consumed by out-of-scope chunks before the KB filter
  // ever ran, starving real candidates and, at RAG_HYBRID_CANDIDATES=20,
  // excluding correct results (spec 0028). The tenant boundary is not
  // something fusion is trusted to preserve, and neither is the KB one.
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
      SELECT c.id,
             ROW_NUMBER() OVER (ORDER BY c.embedding <=> ${queryVector}::halfvec) AS pos
      FROM chunks c
      WHERE c.owner_id = ${ownerId}
        AND c.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
      ORDER BY c.embedding <=> ${queryVector}::halfvec
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
      c.content       AS content,
      c.page_number   AS page_number,
      c.kind          AS kind,
      1 - (c.embedding <=> ${queryVector}::halfvec) AS similarity,
      f.lexical_rank  AS lexical_rank,
      f.vec_rank      AS vec_rank,
      f.lex_rank_pos  AS lex_rank_pos
    FROM fused f
    JOIN chunks c ON c.id = f.id
    JOIN documents d ON d.id = c.document_id
    WHERE c.owner_id = ${ownerId}
      AND c.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
    ORDER BY f.rrf DESC
    LIMIT ${topK}
  `)

  return Array.from(rows)
    .map((r) => {
      const inVector = r.vec_rank !== null
      const inLexical = r.lex_rank_pos !== null
      return {
        chunkId: r.chunk_id,
        documentId: r.document_id,
        documentTitle: r.document_title,
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
      }
    })
    .filter(
      // The gate stays on cosine similarity alone.
      //
      // The first design let a strong lexical hit bypass this floor, so an
      // exact identifier could be admitted despite a weak vector score. It was
      // measured and removed: on the evaluation corpus there is NO lexical-rank
      // threshold that separates true from false positives — "How much parental
      // leave am I entitled to?" (no answer in the corpus) scores 0.60 on
      // `leave`, higher than every genuine identifier query at 0.30. Any
      // threshold admitting the identifier also destroys refusal accuracy,
      // which fell from 1.0 to 0.0 when this was enabled.
      //
      // So the lexical channel improves ORDERING, which is measurable and safe
      // (hit@1 0.824 -> 0.941), and does not decide what is relevant enough to
      // answer from. See spec 0027 for the principled fix.
      (r) => r.similarity >= minSimilarity,
    )
}

/** The caller's indexed documents, for query scoping. */
export async function listReadyDocuments(
  ownerId: string,
  knowledgeBaseIds: readonly string[],
): Promise<ScopableDocument[]> {
  // Same reasoning as retrieveForOwner: an empty selection can list nothing,
  // so there is no reason to touch the database to confirm it (spec 0028
  // FR7). scope.ts's "exactly one document" shortcut depends on this list
  // already being narrowed to the permitted KBs — see the module docstring
  // on `ScopableDocument`.
  if (knowledgeBaseIds.length === 0) return []

  const rows = await db.execute<ReadyDocumentRow>(sql`
    SELECT d.id AS id, d.title AS title
    FROM documents d
    WHERE d.owner_id = ${ownerId}
      AND d.status = 'ready'
      AND d.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
  `)

  return Array.from(rows).map((r) => ({ id: r.id, title: r.title }))
}

/**
 * Retrieve a whole document in reading order, for summarise/overview requests
 * that similarity search structurally cannot serve (see scope.ts).
 *
 * Owner-scoped exactly as the kNN path is — the `ownerId` predicate is on
 * `chunks`, not inferred from the document, so this cannot become a way to
 * read someone else's file by guessing an id.
 *
 * THIS IS THE MOST DANGEROUS FUNCTION IN THIS FILE (spec 0028). It fetches a
 * whole document by id and, before this spec, gated on owner alone — which
 * was sufficient, because owner was the only boundary there was. It no
 * longer is: a conversation scoped to knowledge base A that resolves a
 * document id belonging to the SAME user's knowledge base B would retrieve
 * it in full, because `owner_id` matches (same person) and nothing else
 * stood in the way. That is not a bug that throws or 500s. It looks exactly
 * like retrieval working. Do not "simplify" this back down to an owner-only
 * check on the theory that same-owner data is safe to relax — the whole
 * reason a user made a second knowledge base may be to keep this out of
 * reach of exactly this kind of request.
 */
export async function retrieveDocumentChunks(
  ownerId: string,
  documentId: string,
  knowledgeBaseIds: readonly string[],
): Promise<RetrievedChunk[]> {
  if (knowledgeBaseIds.length === 0) return []

  const rows = await db.execute<DocumentChunkRow>(sql`
    SELECT c.id            AS chunk_id,
           c.document_id   AS document_id,
           d.title         AS document_title,
           c.content       AS content,
           c.page_number   AS page_number,
           c.kind          AS kind
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.owner_id = ${ownerId}
      AND c.document_id = ${documentId}
      AND c.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
    ORDER BY c.chunk_index ASC
    LIMIT ${env.RAG_DOC_SCOPE_MAX_CHUNKS}
  `)

  // Similarity is not meaningful here — the whole document was requested, not
  // the passages nearest a query. Reported as 1 so the citation shape is
  // identical for the UI.
  return Array.from(rows).map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    documentTitle: r.document_title,
    content: r.content,
    pageNumber: Number(r.page_number),
    similarity: 1,
    kind: r.kind,
  }))
}
