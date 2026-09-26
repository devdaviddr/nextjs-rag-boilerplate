/**
 * RAG constants that are NOT configurable, because changing them requires a
 * database migration or breaks a measured assumption. Anything genuinely
 * tunable lives in `src/lib/env.ts` instead.
 */

/**
 * The embeddings are ASYMMETRIC: the same sentence embedded as a passage and
 * as a query is only ~0.785 cosine-similar (measured 2026-09-07). Documents
 * must be embedded as `passage` and questions as `query`; mixing them
 * measurably degrades retrieval, silently.
 */
export type EmbeddingInputType = 'passage' | 'query'

/** Only PDFs are ingestible today (spec 0025 non-goals). */
export const DOCUMENT_MIME_TYPES = ['application/pdf'] as const

/** Returned verbatim when retrieval finds nothing above the similarity floor. */
export const NO_CONTEXT_ANSWER =
  "I couldn't find anything about that in your documents."
