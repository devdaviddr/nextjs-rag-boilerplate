import { describe, expect, it } from 'vitest'

import {
  findMentionedDocument,
  hasWholeDocumentIntent,
  normalise,
  resolveScope,
} from '@/lib/rag/scope'

const docs = [
  { id: 'd1', title: 'rag-sample-handbook' },
  { id: 'd2', title: 'Q3 Financial Report' },
  { id: 'd3', title: 'handbook' },
]

describe('normalise', () => {
  it('folds case, separators and punctuation', () => {
    expect(normalise('rag-sample-handbook')).toBe('rag sample handbook')
    expect(normalise('Q3_Financial.Report!')).toBe('q3 financial report')
  })
})

describe('hasWholeDocumentIntent', () => {
  it.each([
    'summarise rag-sample-handbook',
    'summarize this document',
    'give me a summary',
    'tldr',
    'what is in the handbook?',
    'what does this say',
    'key points please',
    'overview of the report',
    'tell me about the handbook',
  ])('recognises %j', (q) => {
    expect(hasWholeDocumentIntent(q)).toBe(true)
  })

  it.each([
    'How many days of annual leave do I get?',
    'fire assembly point',
    'what is the reimbursement deadline',
    'who approves claims over 500 dollars',
  ])('leaves content question %j to similarity search', (q) => {
    expect(hasWholeDocumentIntent(q)).toBe(false)
  })
})

describe('findMentionedDocument', () => {
  it('matches a title written with different separators', () => {
    expect(
      findMentionedDocument('summarise rag sample handbook', docs)?.id,
    ).toBe('d1')
    expect(
      findMentionedDocument('summarise rag-sample-handbook', docs)?.id,
    ).toBe('d1')
  })

  it('prefers the longest matching title over a shorter substring', () => {
    // Both "handbook" (d3) and "rag-sample-handbook" (d1) appear.
    expect(
      findMentionedDocument('summarise rag-sample-handbook', docs)?.id,
    ).toBe('d1')
  })

  it('returns null when no document is named', () => {
    expect(findMentionedDocument('summarise this document', docs)).toBeNull()
  })

  it('ignores titles too short to match meaningfully', () => {
    expect(findMentionedDocument('a b c', [{ id: 'x', title: 'a' }])).toBeNull()
  })
})

describe('resolveScope', () => {
  it('scopes to the named document for a summary request', () => {
    expect(resolveScope('summarise rag-sample-handbook', docs)).toEqual({
      mode: 'document',
      documentId: 'd1',
      reason: 'named',
    })
  })

  it('scopes to the only document when the request is unambiguous', () => {
    expect(resolveScope('summarise this document', [docs[0]!])).toEqual({
      mode: 'document',
      documentId: 'd1',
      reason: 'only-document',
    })
  })

  it('falls back to search when a summary request is ambiguous', () => {
    // Several documents and none named — do not guess which one.
    expect(resolveScope('summarise this document', docs)).toEqual({
      mode: 'search',
    })
  })

  it('uses search for a content question even when a document is named', () => {
    // Naming a document is not itself a reason to dump the whole thing.
    expect(
      resolveScope('what does rag-sample-handbook say about leave', docs).mode,
    ).toBe('search')
  })

  it('uses search for an ordinary content question', () => {
    expect(resolveScope('How many days of annual leave?', docs)).toEqual({
      mode: 'search',
    })
  })

  it('handles an empty knowledge base', () => {
    expect(resolveScope('summarise this document', [])).toEqual({
      mode: 'search',
    })
  })
})
