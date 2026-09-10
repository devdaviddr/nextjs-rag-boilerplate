import { describe, expect, it } from 'vitest'

import {
  classifyPage,
  crackablePageCount,
  type PageRoute,
  type PageSignals,
  requiresCracking,
} from '@/lib/rag/triage'

/** A page of ordinary single-column prose — the case that must stay free. */
function cleanPage(overrides: Partial<PageSignals> = {}): PageSignals {
  return {
    charCount: 2400,
    itemCount: 60,
    imageCount: 0,
    vectorOpCount: 0,
    columnCount: 1,
    textAreaRatio: 0.45,
    ...overrides,
  }
}

describe('classifyPage', () => {
  it('routes ordinary prose to the free path', () => {
    expect(classifyPage(cleanPage())).toBe('clean-text')
  })

  it('routes a page with no text layer to no-text', () => {
    expect(classifyPage(cleanPage({ charCount: 0, itemCount: 0 }))).toBe(
      'no-text',
    )
    expect(classifyPage(cleanPage({ charCount: 12 }))).toBe('no-text')
  })

  it('treats a scanned page as no-text even when it carries images', () => {
    // This is the appendix case: the document as a whole has plenty of text,
    // so today's document-level isImageOnly average lets it through unindexed.
    expect(classifyPage(cleanPage({ charCount: 3, imageCount: 1 }))).toBe(
      'no-text',
    )
  })

  it('routes a multi-column page to structured', () => {
    expect(classifyPage(cleanPage({ columnCount: 2 }))).toBe('structured')
  })

  it('routes a dense, tabular-looking page to structured', () => {
    // Many short items packed into little area is what a table looks like
    // from the outside, even when the column detector saw one block.
    expect(
      classifyPage(cleanPage({ itemCount: 180, textAreaRatio: 0.12 })),
    ).toBe('structured')
  })

  it('does not call a sparse page dense', () => {
    expect(classifyPage(cleanPage({ itemCount: 8, textAreaRatio: 0.05 }))).toBe(
      'clean-text',
    )
  })

  it('does not call word-granular prose tabular', () => {
    // Measured on `~/Desktop/rag-cracking-test.pdf` p2, a page of plain prose
    // from a producer that emits one item per word: 43 text items over 5.1% of
    // covered area, a ratio of 8.4. The eval corpus emits one item per
    // PARAGRAPH and lands at 1.4–3.8, which is why the threshold was first set
    // where a real document's prose fell foul of it.
    expect(
      classifyPage(cleanPage({ itemCount: 43, textAreaRatio: 0.051 })),
    ).toBe('clean-text')
  })

  it('still calls a genuinely tabular page tabular', () => {
    // Same document, p3 — two stacked tables: 60 items over 5.0%, a ratio of
    // 12.1. The corpus's own table pages sit at 12.1 and 12.5.
    expect(
      classifyPage(cleanPage({ itemCount: 60, textAreaRatio: 0.05 })),
    ).toBe('structured')
  })

  it('never divides by a zero text area', () => {
    const route = classifyPage(
      cleanPage({ itemCount: 100, textAreaRatio: 0, charCount: 900 }),
    )
    expect(['clean-text', 'structured', 'image-heavy']).toContain(route)
  })

  it('routes a text page carrying images to image-heavy', () => {
    expect(classifyPage(cleanPage({ imageCount: 2 }))).toBe('image-heavy')
  })

  it('routes a page with a VECTOR chart to image-heavy', () => {
    // The gap this closes: on the eval corpus the chart page reports
    // imageCount 0, because a drawn chart is paths rather than pixels. Before
    // vectorOpCount existed it took the free path and its figure was never
    // indexed at all.
    expect(classifyPage(cleanPage({ imageCount: 0, vectorOpCount: 7 }))).toBe(
      'image-heavy',
    )
  })

  it('does not treat a few decorative rules as a figure', () => {
    // 3 is what a corner logo contributes once `signals.ts` has discounted the
    // page template's header rule, footer rule and border box. Before it did,
    // that page reported 7 and bought a parse call for a page of prose.
    expect(classifyPage(cleanPage({ vectorOpCount: 3 }))).toBe('clean-text')
  })

  it('prefers structured over image-heavy when both apply', () => {
    // Layout damage is certain; an image may be a logo. Fix the certain thing.
    expect(classifyPage(cleanPage({ columnCount: 3, imageCount: 4 }))).toBe(
      'structured',
    )
  })

  it('honours overridden thresholds', () => {
    const page = cleanPage({ charCount: 100 })
    expect(classifyPage(page, { minChars: 500 })).toBe('no-text')
    expect(classifyPage(page, { minChars: 50 })).toBe('clean-text')
  })
})

describe('requiresCracking', () => {
  it('is false only for clean text', () => {
    expect(requiresCracking('clean-text')).toBe(false)
    for (const route of [
      'structured',
      'image-heavy',
      'no-text',
    ] satisfies PageRoute[]) {
      expect(requiresCracking(route)).toBe(true)
    }
  })
})

describe('crackablePageCount', () => {
  it('is zero for an all-clean document, so it costs nothing (NFR1)', () => {
    const routes: PageRoute[] = Array.from({ length: 200 }, () => 'clean-text')
    expect(crackablePageCount(routes)).toBe(0)
  })

  it('counts only the pages that need help', () => {
    const routes: PageRoute[] = [
      'clean-text',
      'structured',
      'clean-text',
      'no-text',
      'image-heavy',
    ]
    expect(crackablePageCount(routes)).toBe(3)
  })
})
