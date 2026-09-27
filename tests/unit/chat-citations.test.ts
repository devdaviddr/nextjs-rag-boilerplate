import { describe, expect, it } from 'vitest'

import type { StoredCitation } from '@/db/schema'
import { groupCitations, toStoredCitations } from '@/lib/chat/citations'
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

describe('groupCitations (#165)', () => {
  const c = (index: number, documentId: string, pageNumber: number) =>
    ({
      index,
      chunkId: `c${index}`,
      documentId,
      documentTitle: documentId,
      pageNumber,
      similarity: 0.5,
    }) as StoredCitation

  it('puts passages from the same page in one group, in first-seen order', () => {
    const groups = groupCitations([
      c(1, 'handbook', 1),
      c(2, 'policy', 3),
      c(3, 'handbook', 1),
      c(4, 'handbook', 2),
      c(5, 'handbook', 1),
    ])
    expect(groups.map((g) => g.citations.map((x) => x.index))).toEqual([
      [1, 3, 5],
      [2],
      [4],
    ])
  })

  it('keeps a page and a section with the same number apart', () => {
    const section = { ...c(2, 'handbook', 1), unit: 'section' as const }
    expect(groupCitations([c(1, 'handbook', 1), section])).toHaveLength(2)
  })
})
