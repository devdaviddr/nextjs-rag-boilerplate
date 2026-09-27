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

/**
 * The file picker's `accept` list (spec 0046). The loaders decide what is
 * accepted, by the bytes; this only filters the picker, and lives here because
 * a client component cannot import the loaders. A test keeps the two equal.
 */
export const DOCUMENT_ACCEPT = '.pdf,.docx,.html,.htm,.md,.markdown,.txt'

/** Returned verbatim when retrieval finds nothing above the similarity floor. */
export const NO_CONTEXT_ANSWER =
  "I couldn't find anything about that in your documents."
