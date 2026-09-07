import { describe, expect, it } from 'vitest'

import { chunkPages, estimateTokens, type PageText } from '@/lib/rag/chunk'

const OPTS = { chunkTokens: 100, overlapTokens: 20 }

function page(pageNumber: number, text: string): PageText {
  return { pageNumber, text }
}

describe('estimateTokens', () => {
  it('is zero for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('approximates four characters per token, rounding up', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('chunkPages', () => {
  it('returns nothing for empty pages', () => {
    expect(chunkPages([], OPTS)).toEqual([])
    expect(chunkPages([page(1, '   ')], OPTS)).toEqual([])
  })

  it('keeps a short page as a single chunk', () => {
    const chunks = chunkPages([page(1, 'Hello world.')], OPTS)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.content).toBe('Hello world.')
    expect(chunks[0]?.pageNumber).toBe(1)
    expect(chunks[0]?.chunkIndex).toBe(0)
  })

  it('never lets a chunk span a page boundary', () => {
    // Both pages are tiny — a page-agnostic chunker would merge them.
    const chunks = chunkPages([page(1, 'Alpha.'), page(2, 'Beta.')], OPTS)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.pageNumber).toBe(1)
    expect(chunks[1]?.pageNumber).toBe(2)
    expect(chunks[0]?.content).not.toContain('Beta')
  })

  it('numbers chunks sequentially across the whole document', () => {
    const long = Array.from(
      { length: 12 },
      (_, i) => `Para ${i} ${'x'.repeat(200)}`,
    ).join('\n\n')
    const chunks = chunkPages([page(1, long), page(2, long)], OPTS)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i))
  })

  it('respects the token budget', () => {
    const long = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i}. ${'y'.repeat(150)}`,
    ).join('\n\n')
    const chunks = chunkPages([page(1, long)], OPTS)
    for (const chunk of chunks) {
      // Allow the join separator's few characters of slack.
      expect(chunk.tokenCount).toBeLessThanOrEqual(OPTS.chunkTokens + 2)
    }
  })

  it('overlaps consecutive chunks within a page', () => {
    const paragraphs = Array.from(
      { length: 8 },
      (_, i) => `Paragraph number ${i} with enough text to matter here.`,
    ).join('\n\n')
    const chunks = chunkPages([page(1, paragraphs)], {
      chunkTokens: 40,
      overlapTokens: 15,
    })
    expect(chunks.length).toBeGreaterThan(1)
    const first = chunks[0]?.content ?? ''
    const second = chunks[1]?.content ?? ''
    const firstTail = first.split('\n\n').at(-1) ?? ''
    expect(second).toContain(firstTail)
  })

  it('terminates on a single paragraph far larger than the budget', () => {
    // No paragraph or sentence boundaries at all — the hard-slice path.
    const chunks = chunkPages([page(1, 'z'.repeat(10_000))], OPTS)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(OPTS.chunkTokens + 2)
    }
  })

  it('rejects an overlap that would prevent progress', () => {
    expect(() =>
      chunkPages([page(1, 'text')], { chunkTokens: 10, overlapTokens: 10 }),
    ).toThrow(/smaller than/)
  })
})
