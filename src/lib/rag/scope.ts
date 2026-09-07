/**
 * Query scoping — deciding whether a question is a *content* question or a
 * *whole-document* request.
 *
 * Similarity search answers "which passage is about X". It cannot answer
 * "summarise this document", because such a request has no semantic anchor in
 * the content: measured against a 3-page handbook, "summarise <title>" scored
 * 0.172 and "summarise this document" 0.077, while real content questions
 * scored 0.48-0.55. Lowering the similarity floor would not fix that — it
 * would only admit noise. Whole-document requests need retrieval BY DOCUMENT
 * rather than by similarity.
 *
 * Pure and dependency-free so the matching rules are unit-testable.
 */

export interface ScopableDocument {
  id: string
  title: string
}

/** Lower-case, and collapse punctuation/separators to single spaces. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Requests that want the document as a whole rather than a passage from it.
 * Kept deliberately narrow: a false positive sends whole documents to the
 * model, which is expensive and blunts retrieval precision.
 */
const WHOLE_DOCUMENT_INTENT =
  /\b(summar(y|ise|ize|ising|izing)|tl;?dr|overview|outline|gist|key points|main points|what(?:'s| is| are)? (?:in|this|it) (?:about|document|file|pdf)?|what does (?:this|it) (?:say|cover|contain)|tell me about)\b/i

export function hasWholeDocumentIntent(question: string): boolean {
  return WHOLE_DOCUMENT_INTENT.test(question)
}

/**
 * Find a document the user named in their question.
 *
 * Matches on the normalised title appearing in the normalised question, so
 * "summarise rag-sample-handbook" resolves the document titled
 * "rag-sample-handbook". Longest title wins, so a more specific name beats a
 * shorter one that happens to be a prefix. Very short titles (under three
 * characters once normalised) are ignored — they match by accident.
 */
export function findMentionedDocument<T extends ScopableDocument>(
  question: string,
  documents: readonly T[],
): T | null {
  const haystack = normalise(question)
  let best: T | null = null
  let bestLength = 0

  for (const doc of documents) {
    const needle = normalise(doc.title)
    if (needle.length < 3) continue
    if (haystack.includes(needle) && needle.length > bestLength) {
      best = doc
      bestLength = needle.length
    }
  }
  return best
}

export type Scope =
  | { mode: 'search' }
  | { mode: 'document'; documentId: string; reason: 'named' | 'only-document' }

/**
 * Decide how to retrieve for this question.
 *
 * A whole-document request resolves to one document when the user named it,
 * or when they only have one document at all (in which case "summarise this
 * document" is unambiguous). Everything else falls through to similarity
 * search, so the grounding guarantee is untouched: a content question that
 * matches nothing is still refused without calling the model.
 */
export function resolveScope(
  question: string,
  documents: readonly ScopableDocument[],
): Scope {
  const named = findMentionedDocument(question, documents)

  if (named && hasWholeDocumentIntent(question)) {
    return { mode: 'document', documentId: named.id, reason: 'named' }
  }
  if (hasWholeDocumentIntent(question) && documents.length === 1) {
    const only = documents[0]
    if (only) {
      return { mode: 'document', documentId: only.id, reason: 'only-document' }
    }
  }
  return { mode: 'search' }
}
