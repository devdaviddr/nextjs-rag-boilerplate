import { describe, expect, it } from 'vitest'

import { countColumns, countDrawOps, textAreaRatio } from '@/lib/rag/signals'

/**
 * The pure half of signal gathering. `collectPageSignals` itself needs a live
 * PDF and is exercised end to end against `eval/corpus`; everything decidable
 * without one is pinned here.
 *
 * Both fixtures below are geometry measured off the eval corpus, not invented:
 * the whitespace filler and the operator counts are what pdf.js actually
 * returned on 2026-09-10.
 */

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

describe('countColumns', () => {
  it('sees one column in ordinary prose', () => {
    const items = [
      { str: 'The annual leave entitlement is', x: 60, width: 200 },
      { str: '20 working days per year.', x: 60, width: 180 },
    ]
    expect(countColumns(items, PAGE_WIDTH)).toBe(1)
  })

  it('sees two columns in a two-column page', () => {
    const items = [
      { str: 'The north wing lift was upgraded', x: 60, width: 155 },
      { str: 'The south wing lift remains on', x: 330, width: 149 },
    ]
    expect(countColumns(items, PAGE_WIDTH)).toBe(2)
  })

  it('ignores the whitespace item pdf.js puts in the gutter', () => {
    // Measured: a two-column page produced `x=215.1 w=114.9 " "` sitting
    // exactly between the columns. Counting it bridges the gap, every measured
    // gap falls under the threshold, and the page reports as single-column —
    // which routed an interleaved page to the free path.
    const withFiller = [
      { str: 'The north wing lift was upgraded', x: 60, width: 155.1 },
      { str: ' ', x: 215.1, width: 114.9 },
      { str: 'The south wing lift remains on', x: 330, width: 149.5 },
    ]
    expect(countColumns(withFiller, PAGE_WIDTH)).toBe(2)
  })

  it('ignores a full-width banner that would merge every column', () => {
    const items = [
      { str: 'SITE OPERATIONS REPORT', x: 30, width: 560 },
      { str: 'left body text here', x: 60, width: 150 },
      { str: 'right body text here', x: 330, width: 150 },
    ]
    expect(countColumns(items, PAGE_WIDTH)).toBe(2)
  })

  it('is zero for an empty page and one when only fillers remain', () => {
    expect(countColumns([], PAGE_WIDTH)).toBe(0)
    expect(countColumns([{ str: '  ', x: 10, width: 30 }], PAGE_WIDTH)).toBe(1)
  })

  it('does not divide by a zero page width', () => {
    expect(countColumns([{ str: 'a', x: 0, width: 10 }], 0)).toBe(0)
  })
})

describe('textAreaRatio', () => {
  it('is zero with no items and clamped to one when items overlap', () => {
    expect(textAreaRatio([], PAGE_WIDTH, PAGE_HEIGHT)).toBe(0)
    const huge = [{ width: 10_000, height: 10_000 }]
    expect(textAreaRatio(huge, PAGE_WIDTH, PAGE_HEIGHT)).toBe(1)
  })

  it('treats negative dimensions as their magnitude', () => {
    const ratio = textAreaRatio(
      [{ width: -100, height: -100 }],
      PAGE_WIDTH,
      PAGE_HEIGHT,
    )
    expect(ratio).toBeGreaterThan(0)
  })

  it('does not divide by a zero page', () => {
    expect(textAreaRatio([{ width: 10, height: 10 }], 0, 0)).toBe(0)
  })
})

describe('countDrawOps', () => {
  // The subset of pdf.js's OPS table these counts depend on.
  const OPS = {
    beginText: 1,
    setFont: 2,
    showText: 3,
    constructPath: 91,
    rawFillPath: 94,
    shadingFill: 62,
    paintImageXObject: 85,
    paintImageMaskXObject: 83,
  }

  it('counts nothing on a text-only page', () => {
    const fnArray = [1, 2, 3, 3, 3]
    expect(countDrawOps(fnArray, OPS)).toEqual({
      imageCount: 0,
      vectorOpCount: 0,
    })
  })

  it('counts the vector chart the corpus actually contains', () => {
    // Measured on site-operations-report p3: 7 constructPath, no images.
    const fnArray = [1, 2, ...Array<number>(7).fill(91), 3]
    expect(countDrawOps(fnArray, OPS)).toEqual({
      imageCount: 0,
      vectorOpCount: 7,
    })
  })

  it('counts the scanned page the corpus actually contains', () => {
    // Measured on maintenance-log p2: a single paintImageXObject, no text.
    expect(countDrawOps([85], OPS)).toEqual({
      imageCount: 1,
      vectorOpCount: 0,
    })
  })

  it('ignores operators the running pdf.js does not define', () => {
    // Names are resolved from OPS at run time precisely so an absent one is
    // skipped rather than matching opcode `undefined`.
    const partial = { constructPath: 91 }
    expect(countDrawOps([91, 85, 62], partial)).toEqual({
      imageCount: 0,
      vectorOpCount: 1,
    })
  })
})
