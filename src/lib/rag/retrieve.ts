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
  /** Cosine similarity, always computed — even for lexical-only hits. */
  similarity: number
  /** `ts_rank_cd` for the lexical channel; 0 when the chunk did not match. */
  lexicalRank?: number
  /** Which channel(s) surfaced it. Useful in evaluation and debugging. */
  source?: 'vector' | 'lexical' | 'both'
}

// `db.execute<T>` constrains T to Record<string, unknown>.
interface Row extends Record<string, unknown> {
  chunk_id: string
  document_id: string
  document_title: string
  content: string
  page_number: number
  similarity: number
  lexical_rank: number
  vec_rank: number | null
  lex_rank_pos: number | null
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
  const candidates = env.RAG_HYBRID_CANDIDATES
  const rrfK = env.RAG_RRF_K

  const queryVector = toVectorLiteral(await embedQuery(question))

  // Hybrid retrieval (spec 0027, 1b): a dense channel and a lexical one, fused
  // with Reciprocal Rank Fusion.
  //
  // RRF combines ranks rather than scores, which matters because cosine
  // similarity and ts_rank_cd are not on comparable scales — normalising them
  // against each other is the fragile part of naive hybrid search, and RRF
  // sidesteps it entirely.
  //
  // Both channels are owner-scoped in their own WHERE clause. The tenant
  // boundary is not something fusion is trusted to preserve.
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
      ORDER BY c.embedding <=> ${queryVector}::halfvec
      LIMIT ${candidates}
    ),
    lex AS (
      SELECT c.id,
             ts_rank_cd(c.content_tsv, q.query) AS rank,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.content_tsv, q.query) DESC) AS pos
      FROM chunks c CROSS JOIN q
      WHERE c.owner_id = ${ownerId}
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
      1 - (c.embedding <=> ${queryVector}::halfvec) AS similarity,
      f.lexical_rank  AS lexical_rank,
      f.vec_rank      AS vec_rank,
      f.lex_rank_pos  AS lex_rank_pos
    FROM fused f
    JOIN chunks c ON c.id = f.id
    JOIN documents d ON d.id = c.document_id
    WHERE c.owner_id = ${ownerId}
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
