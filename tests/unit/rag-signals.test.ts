import { describe, expect, it } from 'vitest'

import { countColumns, countDrawOps, textAreaRatio } from '@/lib/rag/signals'

/**
 * The pure half of signal gathering. `collectPageSignals` itself needs a live
 * PDF and is exercised end to end against `eval/corpus`; everything decidable
 * without one is pinned here.
 *
 * The fixtures below are geometry measured off real PDFs, not invented: the
 * whitespace filler and the corpus operator counts are what pdf.js returned on
 * 2026-09-10, and the header/footer/frame/chart boxes are what it returned for
 * a realistically styled 8-page report on 2026-09-11.
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
    save: 10,
    restore: 11,
    transform: 12,
    paintFormXObjectBegin: 74,
    paintFormXObjectEnd: 75,
    constructPath: 91,
    rawFillPath: 94,
    shadingFill: 62,
    paintImageXObject: 85,
    paintImageMaskXObject: 83,
  }

  /**
   * One `constructPath` with the given page-space box, in the argument shape
   * pdf.js emits: `[pathOps, [coords], minMax]`.
   */
  const path = (
    xMin: number,
    yMin: number,
    xMax: number,
    yMax: number,
  ): unknown => [
    [0, 1],
    [new Float32Array([xMin, yMin, xMax, yMax])],
    [xMin, yMin, xMax, yMax],
  ]

  /** Boxes measured off `~/Desktop/rag-cracking-test.pdf`, scaled to Letter. */
  const HEADER_RULE = path(51.7, 774, 544.5, 775)
  const FRAME = path(46, 48, 566, 744)
  const CHART_BAR = path(70, 400, 122, 560)
  const CHART_AXIS = path(100, 400, 438, 400.5)
  const TABLE_CELL_RULE = path(51, 500, 129, 501)

  const count = (
    fnArray: number[],
    argsArray: unknown[],
    ops: Record<string, number> = OPS,
  ) => countDrawOps(fnArray, argsArray, ops, PAGE_WIDTH, PAGE_HEIGHT)

  it('counts nothing on a text-only page', () => {
    expect(count([1, 2, 3, 3, 3], [null, null, null, null, null])).toEqual({
      imageCount: 0,
      vectorOpCount: 0,
    })
  })

  it('counts the vector chart the corpus actually contains', () => {
    // Measured on site-operations-report p3: 7 constructPath, no images.
    const fnArray = [1, 2, ...Array<number>(7).fill(91), 3]
    const argsArray = [null, null, ...Array<unknown>(7).fill(CHART_BAR), null]
    expect(count(fnArray, argsArray)).toEqual({
      imageCount: 0,
      vectorOpCount: 7,
    })
  })

  it('counts the scanned page the corpus actually contains', () => {
    // Measured on maintenance-log p2: a single paintImageXObject, no text.
    expect(count([85], [null])).toEqual({ imageCount: 1, vectorOpCount: 0 })
  })

  it('ignores operators the running pdf.js does not define', () => {
    // Names are resolved from OPS at run time precisely so an absent one is
    // skipped rather than matching opcode `undefined`.
    const partial = { constructPath: 91 }
    expect(count([91, 85, 62], [CHART_BAR, null, null], partial)).toEqual({
      imageCount: 0,
      vectorOpCount: 1,
    })
  })

  it('does not count the running header and footer rules', () => {
    // The regression this exists for: a ruled header, a ruled footer and a
    // border box appear on EVERY page of a corporate template, and three of
    // them plus a logo cleared minVectorOps on pages of ordinary prose.
    const FOOTER_RULE = path(51.7, 60, 544.5, 61)
    expect(
      count([91, 91, 91], [HEADER_RULE, FOOTER_RULE, FRAME]).vectorOpCount,
    ).toBe(0)
  })

  it('still counts what a chart and a table draw', () => {
    // The discrimination: a header rule spans the text column, a chart's
    // paths are tall and a table's rules are short. Measured widths on the
    // test document were 0.827 for the rules against 0.656 and 0.400.
    expect(
      count([91, 91, 91], [CHART_BAR, CHART_AXIS, TABLE_CELL_RULE])
        .vectorOpCount,
    ).toBe(3)
  })

  it('measures the box in page space, not the space it was drawn in', () => {
    // pdf.js reports path bounds BEFORE the CTM: on the test document a
    // header rule comes back as x 8..665 on a 596-point page. Untransformed
    // it looks like a narrow mark and gets counted; transformed it is a rule.
    const raw = path(5.17, 77.4, 54.45, 77.5)
    const scale = [10, 0, 0, 10, 0, 0]

    expect(count([91], [raw]).vectorOpCount).toBe(1)
    expect(count([12, 91], [scale, raw]).vectorOpCount).toBe(0)
  })

  it('restores the CTM, so a transform cannot leak past its restore', () => {
    const raw = path(5.17, 77.4, 54.45, 77.5)
    const scale = [10, 0, 0, 10, 0, 0]
    // save · transform · <path> · restore · <same path>: the first is a rule
    // under the scale, the second is a narrow mark without it.
    expect(
      count([10, 12, 91, 11, 91], [null, scale, raw, null, raw]).vectorOpCount,
    ).toBe(1)
  })

  it('counts an operation whose geometry cannot be established', () => {
    // `shadingFill` carries no bounds, and a malformed argument list is a
    // shape change in pdf.js we would rather over-count than silently drop:
    // under-counting hides a figure, which is the failure this pipeline fixes.
    expect(count([62, 91], [['pattern'], ['nonsense']]).vectorOpCount).toBe(2)
  })
})
