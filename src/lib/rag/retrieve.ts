import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import type { ChunkKind } from '@/db/schema'
import { activeEmbedding, aiSettings } from '@/lib/ai-settings'
import { embedQuery } from './embed'
import { generationLiteral, halfvecType } from './generation-sql'
import { hypotheticalQuery } from './hyde'
import {
  type PageRow,
  collapseParents,
  pagesToLoad,
  parentMaxTokens,
} from './parents'
import { rerankChunks } from './rerank'
import { span } from '@/lib/observability/runs'

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
  /**
   * The reranker's score for this chunk (spec 0036 FR6), present only when
   * reranking ran and produced a usable answer. Higher is more relevant; the
   * scale is the backend's, so it is comparable only within one query's
   * results. Recorded so the evaluation harness and the trace can show what
   * reranking changed — its absence on every chunk means it did not run.
   */
  rerankScore?: number
  /**
   * The section heading the chunk was indexed under, and where it sits on the
   * page (spec 0033, 1c). Together they are the SECTION KEY that parent
   * assembly groups by — see `parents.ts`. Present only when the row has one,
   * so a chunk without a heading is the same shape it always was.
   */
  heading?: string | null
  headingBbox?: unknown
  /**
   * Set only on an assembled PARENT (spec 0033, 1c): every chunk of the
   * section run, in reading order. `chunkId` is then the run's first chunk
   * and `content` the whole run. Absent on an ordinary chunk — its absence is
   * how every consumer tells the two apart.
   */
  memberChunkIds?: string[]
  /** How many of the parent's members the gate admitted on their own. */
  assembledFrom?: number
}

export interface RetrieveOptions {
  topK?: number
  minSimilarity?: number
  /**
   * Assemble parents from admitted children (spec 0033, 1c). Defaults to
   * `RAG_PARENT_ASSEMBLY`. The evaluation harness turns it off to score the
   * flat list and the assembled one from the same retrieval.
   */
  assembleParents?: boolean
  /**
   * Cuts off the model calls this search makes (HyDE, the query embedding),
   * e.g. at the agentic loop's time budget (#92). The database query itself
   * is not interruptible and is fast next to either.
   */
  signal?: AbortSignal
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

/**
 * How many fused candidates to carry past fusion, before the gate and the cut
 * to `topK`.
 *
 * ## The defect this exists to fix
 *
 * Spec 0036 FR1 says the reranker "re-scores the top `RAG_RERANK_CANDIDATES`"
 * (20). It could not. The fused SELECT ended `LIMIT ${topK}` — 8 — so
 * `rerankChunks` was handed eight rows and its own window collapsed to
 * `min(20, 8) = 8`. `RAG_RERANK_CANDIDATES` was dead configuration, and the
 * reranker could only reorder the eight chunks that had already won; it could
 * never promote a better chunk sitting at fusion rank 9. Rescuing rank 9 is
 * the entire reason a reranker exists, so the stage was structurally incapable
 * of its own purpose while every test passed and every metric looked fine.
 *
 * The pipeline is therefore: fuse -> keep this many -> rerank -> gate -> cut
 * to `topK`. The cut moved to the end, where it belongs.
 *
 * ## Only reranking widens anything
 *
 * With `RAG_RERANK_ENABLED` false this returns `topK` and every downstream
 * step is a no-op: the SQL LIMIT is what it always was, `rerankChunks` returns
 * its input, and the final `slice(0, topK)` cannot trim a list of at most
 * `topK`. Disabled behaviour is byte-identical to before this change, which is
 * asserted against a written-down expectation in `tests/unit/rag-rerank.test.ts`
 * ("returns exactly the recorded chunks when reranking is off") rather than
 * argued here.
 *
 * That tie is deliberate rather than tidy. Widening the pool is NOT the
 * order-only change reranking itself is: the gate is a per-element predicate,
 * so it admits the same fraction of whatever it is shown, but showing it 20
 * candidates instead of 8 can let a chunk that fusion ranked 12th — and that
 * clears the similarity floor — reach an answer that today returns nothing.
 * That can move refusal accuracy, in the answering direction, and it is the
 * one metric this project holds at 1.000 across five specs. Keeping the wider
 * pool behind the same flag as the reranker means turning reranking on is the
 * only way to find out, which is what the flag is for.
 */
function candidatePoolSize(topK: number): number {
  if (!aiSettings().RAG_RERANK_ENABLED) return topK
  // Below topK a "wider" pool would be narrower than the answer and would
  // discard chunks the gate would have kept, so the floor is topK, not 1.
  return Math.max(topK, aiSettings().RAG_RERANK_CANDIDATES)
}

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

  const topK = options.topK ?? aiSettings().RAG_TOP_K
  const minSimilarity = options.minSimilarity ?? aiSettings().RAG_MIN_SIMILARITY
  const rrfK = aiSettings().RAG_RRF_K

  // How many fused rows survive to the rerank stage, before the gate and the
  // cut to topK. `topK` unless reranking is on — see candidatePoolSize above
  // for the defect that motivated it.
  const poolSize = candidatePoolSize(topK)

  // Filtered-ANN caveat (docs/rag.md): pgvector applies the owner predicate
  // AFTER the HNSW scan, so a tenant holding a small share of all chunks can
  // already get fewer than topK results back at the existing owner-only
  // scope. A second narrowing predicate — KB membership — thins the same
  // fixed-size candidate pool further, and does so worse the fewer KBs are
  // selected out of however many the user has. This function has no cheap
  // way to see the user's total KB count, so the number of KBs actually
  // selected is the only signal available; scale the per-channel LIMIT by
  // it, capped so the worst case (many KBs selected at once) stays bounded.
  const perChannel =
    aiSettings().RAG_HYBRID_CANDIDATES * knowledgeBaseIds.length
  const candidates = Math.min(
    // A channel that offers fewer rows than the pool wants makes the widened
    // pool a fiction: fusion cannot hand on 20 candidates if neither channel
    // produced 20. Only reached when the pool was actually widened, so the
    // scan is untouched at defaults (20 per channel, pool 20) and untouched
    // entirely with reranking off.
    poolSize > topK ? Math.max(perChannel, poolSize) : perChannel,
    CANDIDATE_POOL_CEILING,
  )

  // HyDE (spec 0033 FR6): embed a hypothetical ANSWER rather than the
  // question, because an answer looks more like the passage containing it.
  // Returns null when disabled or when the generation failed in any way, and
  // null means "embed the question" — so with RAG_HYDE_ENABLED off this is one
  // falsy check and the embedding call below is exactly what it always was.
  //
  // The hypothetical replaces the question for the WHOLE vector channel: it
  // orders the ANN scan and it is what `similarity` below is measured against.
  // That is deliberate and it is why the flag is off by default — hyde.ts
  // explains why pinning the gate to the question's own vector instead would
  // make HyDE unevaluable, and what re-measuring it therefore costs.
  //
  // The LEXICAL channel deliberately keeps the real question. A hypothetical
  // is invented vocabulary, and feeding invented terms to `to_tsquery` would
  // have the lexical channel vote for passages matching words the user never
  // typed — the one channel whose value is that it matches what was actually
  // asked.
  // Each stage is a step of the current run, if there is one (spec 0042).
  // The generation this search reads, read once (#56): the question is
  // embedded with its model and compared at its size, even if a swap lands
  // while this runs.
  const active = activeEmbedding()

  const hypothetical = aiSettings().RAG_HYDE_ENABLED
    ? await span('hyde', async (step) => {
        const drafted = await hypotheticalQuery(question, {
          signal: options.signal,
        })
        step.set({ drafted: drafted !== null, passage: drafted })
        return drafted
      })
    : null
  const queryVector = toVectorLiteral(
    await span('embed-question', () =>
      embedQuery(hypothetical ?? question, options.signal, active),
    ),
  )

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
  // Its id and size go in as literals so its partial index is always usable
  // (see generation-sql.ts).
  const generation = generationLiteral(active.generationId)
  const vecType = halfvecType(active.dimensions)

  const rows = await span('search-index', async (step) => {
    const found = await db.execute<Row>(sql`
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
    LEFT JOIN chunk_embeddings e
      ON e.chunk_id = c.id AND e.generation_id = ${generation}
    WHERE c.owner_id = ${ownerId}
      AND c.knowledge_base_id = ANY(${kbIdArray(knowledgeBaseIds)})
    ORDER BY f.rrf DESC
    LIMIT ${poolSize}
  `)
    step.set({ candidates: found.length, question })
    return found
  })

  const fused: RetrievedChunk[] = Array.from(rows).map((r) => {
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
      // Only when present, so a heading-less chunk is byte-for-byte the shape
      // it was before parent assembly existed.
      ...(r.heading != null ? { heading: r.heading } : {}),
      ...(r.heading_bbox != null ? { headingBbox: r.heading_bbox } : {}),
    }
  })

  // Rerank BETWEEN fusion and the gate (spec 0036 FR1). Fusion chose
  // `poolSize` candidates, the reranker re-scores them, the gate decides what
  // survives, and the cut to `topK` happens LAST. After the gate would be the
  // one placement that cannot help — but so is before a `LIMIT topK`, which is
  // what this used to be and why `RAG_RERANK_CANDIDATES` did nothing.
  //
  // The reranker is handed the real question, never the hypothetical. It reads
  // question and passage together, which is the whole reason it discriminates
  // better than a vector distance; giving it invented text to compare against
  // would throw that away.
  //
  // Reranking is a permutation and nothing more (see rerank.ts), so the filter
  // below admits the identical set whether reranking ran, was disabled or
  // failed. What the pool WIDTH admits is a separate question, answered in
  // candidatePoolSize above.
  const ranked = aiSettings().RAG_RERANK_ENABLED
    ? await span('rerank', async (step) => {
        const out = await rerankChunks(question, fused)
        step.set({
          candidates: fused.length,
          topChanged: out[0]?.chunkId !== fused[0]?.chunkId,
        })
        return out
      })
    : await rerankChunks(question, fused)

  const admitted = ranked.filter(
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

  // Parent assembly (spec 0033, 1c), after the gate and before the cut. It
  // only ever rewrites what the gate admitted — two or more children of one
  // section run become that run — so an empty list stays empty and refusal
  // cannot flip. With reranking off `admitted.length <= topK`, so assembling
  // before the cut equals assembling after it.
  const assemble = options.assembleParents ?? aiSettings().RAG_PARENT_ASSEMBLY
  const assembled = assemble
    ? await assembleParents(ownerId, knowledgeBaseIds, admitted)
    : admitted

  // The cut to topK, last. With reranking off `admitted.length <= topK`
  // already, so this cannot change the disabled result — it is the step that
  // lets the pool be wider than the answer without the answer growing.
  return assembled.slice(0, topK)
}

/**
 * Replace admitted children with their section parent (spec 0033, 1c).
 *
 * Exported so the evaluation harness can score the flat list and the
 * assembled one from a SINGLE retrieval (`--parents-ab`), with no second
 * embedding call and so no second chance for the result to differ.
 *
 * No query runs unless two admitted chunks share a page and a section key —
 * refusal and the common case cost nothing. When one does run, it is scoped
 * exactly as every other query in this file: `owner_id` and
 * `knowledge_base_id = ANY(...)` in the WHERE clause (spec 0028), never
 * inferred from the chunk ids the caller already holds. Those ids came from
 * this user's own retrieval, but a loader that trusted them would be one
 * refactor away from reading any page by id. `chunks_document_id_idx` serves
 * the `(document_id, page_number)` predicate.
 */
export async function assembleParents(
  ownerId: string,
  knowledgeBaseIds: readonly string[],
  admitted: readonly RetrievedChunk[],
): Promise<RetrievedChunk[]> {
  if (knowledgeBaseIds.length === 0) return [...admitted]
  const pages = pagesToLoad(admitted)
  if (pages.length === 0) return [...admitted]

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

  const pageRows: PageRow[] = Array.from(rows).map((r) => ({
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

  // Derived, not configured: three chunks' worth. A run bigger than that is
  // not one passage, and stays as the children the gate admitted.
  return collapseParents(admitted, pageRows, {
    maxTokens: parentMaxTokens(aiSettings().RAG_CHUNK_TOKENS),
  })
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

/** One chunk of a document, before its text is loaded (#99). */
export interface DocumentOutlineRow {
  id: string
  chunkIndex: number
  pageNumber: number
  heading: string | null
}

/**
 * Which chunks of a document a whole-document request reads (#99).
 *
 * Up to `max`, all of them. Past that, the first `max` would describe only the
 * opening of a long document, so the choice is made across all of it:
 *
 * 1. The document is split into sections: a run of chunks under one heading,
 *    or, where no heading was detected, one page.
 * 2. With no more sections than `max`, every section's first chunk is taken,
 *    then the remaining slots go to each section's next chunk in turn.
 * 3. With more sections than `max`, `max` sections are taken, spread evenly
 *    from the first to the last, and each gives its first chunk.
 *
 * Returned in reading order. Pure, so it is tested without a database.
 */
export function chooseDocumentChunks(
  rows: readonly DocumentOutlineRow[],
  max: number,
): string[] {
  const ordered = [...rows].sort((a, b) => a.chunkIndex - b.chunkIndex)
  if (ordered.length <= max) return ordered.map((r) => r.id)
  if (max <= 0) return []

  const sections: DocumentOutlineRow[][] = []
  let key: string | null = null
  for (const row of ordered) {
    const rowKey = row.heading?.trim()
      ? `h:${row.heading.trim()}`
      : `p:${row.pageNumber}`
    if (rowKey !== key || sections.length === 0) {
      sections.push([])
      key = rowKey
    }
    sections.at(-1)!.push(row)
  }

  const chosen = new Set<string>()
  if (sections.length > max) {
    const last = sections.length - 1
    for (let i = 0; i < max; i++) {
      const at = max === 1 ? 0 : Math.round((i * last) / (max - 1))
      chosen.add(sections[at]![0]!.id)
    }
  } else {
    for (let depth = 0; chosen.size < max; depth++) {
      let added = false
      for (const section of sections) {
        const row = section[depth]
        if (row && chosen.size < max) {
          chosen.add(row.id)
          added = true
        }
      }
      if (!added) break
    }
  }
  return ordered.filter((r) => chosen.has(r.id)).map((r) => r.id)
}

/** A whole document as a whole-document request reads it (#99). */
export interface WholeDocument {
  chunks: RetrievedChunk[]
  /** How many chunks the document has; more than `chunks.length` when sampled. */
  totalChunks: number
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
export async function retrieveWholeDocument(
  ownerId: string,
  documentId: string,
  knowledgeBaseIds: readonly string[],
): Promise<WholeDocument> {
  if (knowledgeBaseIds.length === 0) return { chunks: [], totalChunks: 0 }

  // The outline first: ids and positions only, so a long document's text is
  // never loaded just to be left out.
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
  const rows = Array.from(outline).map((r) => ({
    id: r.id,
    chunkIndex: Number(r.chunk_index),
    pageNumber: Number(r.page_number),
    heading: r.heading,
  }))
  const ids = chooseDocumentChunks(rows, aiSettings().RAG_DOC_SCOPE_MAX_CHUNKS)
  if (ids.length === 0) return { chunks: [], totalChunks: rows.length }

  const loaded = await db.execute<DocumentChunkRow>(sql`
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
      AND c.id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    ORDER BY c.chunk_index ASC
  `)

  // Similarity is not meaningful here — the whole document was requested, not
  // the passages nearest a query. Reported as 1 so the citation shape is
  // identical for the UI.
  return {
    chunks: Array.from(loaded).map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      documentTitle: r.document_title,
      content: r.content,
      pageNumber: Number(r.page_number),
      similarity: 1,
      kind: r.kind,
    })),
    totalChunks: rows.length,
  }
}

/** The chunks of `retrieveWholeDocument`, for callers that need no count. */
export async function retrieveDocumentChunks(
  ownerId: string,
  documentId: string,
  knowledgeBaseIds: readonly string[],
): Promise<RetrievedChunk[]> {
  return (await retrieveWholeDocument(ownerId, documentId, knowledgeBaseIds))
    .chunks
}
