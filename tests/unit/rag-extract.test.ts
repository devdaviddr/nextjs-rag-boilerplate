import { describe, expect, it, vi } from 'vitest'

// extract.ts imports env for its page/character limits; the pure helper under
// test does not need real values, so keep the suite free of process.env setup.
vi.mock('@/lib/env', () => ({
  env: { RAG_MIN_CHARS_PER_PAGE: 50, RAG_MAX_DOCUMENT_PAGES: 200 },
}))

import { isImageOnly } from '@/lib/rag/extract'
import type { PageText } from '@/lib/rag/chunk'

function pages(...lengths: number[]): PageText[] {
  return lengths.map((len, i) => ({
    pageNumber: i + 1,
    text: 'a'.repeat(len),
  }))
}

describe('isImageOnly', () => {
  it('treats a document with no pages as image-only', () => {
    expect(isImageOnly([], 50)).toBe(true)
  })

  it('flags a scanned PDF with no text layer', () => {
    expect(isImageOnly(pages(0, 0, 0), 50)).toBe(true)
  })

  it('accepts a normal text PDF', () => {
    expect(isImageOnly(pages(2000, 1800, 2200), 50)).toBe(false)
  })

  it('averages across pages, so a few image pages do not reject the document', () => {
    // A cover and a chart page with no text, plus three dense pages.
    expect(isImageOnly(pages(0, 0, 3000, 3000, 3000), 50)).toBe(false)
  })

  it('flags a document that is mostly empty even with one dense page', () => {
    expect(isImageOnly(pages(300, 0, 0, 0, 0, 0, 0, 0), 50)).toBe(true)
  })
})
