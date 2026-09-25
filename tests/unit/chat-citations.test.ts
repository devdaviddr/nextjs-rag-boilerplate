import { describe, expect, it } from 'vitest'

import { toStoredCitations } from '@/lib/chat/citations'
import type { RetrievedChunk } from '@/lib/rag/retrieve'

function retrieved(over: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: 'a',
    documentId: 'doc-1',
    documentTitle: 'Records policy',
    content: 'text',
    pageNumber: 3,
    similarity: 0.512345,
    ...over,
  } as RetrievedChunk
}

describe('toStoredCitations', () => {
  it('numbers from 1 in retrieval order and rounds the score', () => {
    const out = toStoredCitations([
      retrieved({ chunkId: 'x' }),
      retrieved({ chunkId: 'y', similarity: 0.4 }),
    ])
    expect(out).toEqual([
      {
        index: 1,
        chunkId: 'x',
        documentId: 'doc-1',
        documentTitle: 'Records policy',
        pageNumber: 3,
        similarity: 0.5123,
      },
      {
        index: 2,
        chunkId: 'y',
        documentId: 'doc-1',
        documentTitle: 'Records policy',
        pageNumber: 3,
        similarity: 0.4,
      },
    ])
  })

  // Spec 0033 1c: the flag is what makes the panel ask for the whole run.
  it('flags an assembled section parent, and only a parent', () => {
    const [parent, lone, empty] = toStoredCitations([
      retrieved({ chunkId: 'a', memberChunkIds: ['a', 'b', 'c'] }),
      retrieved({ chunkId: 'z' }),
      retrieved({ chunkId: 'q', memberChunkIds: [] }),
    ])
    expect(parent?.parent).toBe(true)
    expect(parent?.chunkId).toBe('a')
    expect(lone).not.toHaveProperty('parent')
    expect(empty).not.toHaveProperty('parent')
  })
})
