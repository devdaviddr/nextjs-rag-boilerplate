import { describe, expect, it } from 'vitest'

import { chunkElements } from '@/lib/rag/chunk'
import type { NormalizedElement } from '@/lib/rag/normalize'
import { toPositionedItems } from '@/lib/rag/signals'

/**
 * One coordinate convention, converted once (spec 0035 FR2).
 *
 * The whole point of this suite is the sentence in the spec: "a consumer that
 * must ask which path produced a chunk before it can read its box has been
 * handed the problem rather than a solution." So the same physical region of
 * the same page is fed in through both paths and the two boxes are compared.
 *
 * A4 portrait is used throughout because the numbers are memorable: 595 x 842
 * PDF units, origin bottom-left, so a heading 40 units below the top edge sits
 * at y = 802 in PDF space and ymin ≈ 0.048 in ours.
 */
const A4 = { view: [0, 0, 595, 842] as const, rotation: 0 }

function pdfItem(str: string, x: number, y: number, w: number, h: number) {
  return { str, x, y, width: w, height: h }
}

describe('toPositionedItems', () => {
  it('flips the y-axis, so the top of the page is ymin 0', () => {
    // A line whose baseline is 12 units below the top edge of the page.
    const [item] = toPositionedItems(
      [pdfItem('HEADING', 59.5, 830, 119, 12)],
      A4,
    )
    expect(item?.box?.ymin).toBeCloseTo(0, 2)
    expect(item?.box?.xmin).toBeCloseTo(0.1, 3)
    expect(item?.box?.xmax).toBeCloseTo(0.3, 3)
  })

  it('puts a footer at the bottom, not the top', () => {
    const [item] = toPositionedItems([pdfItem('Page 1', 59.5, 20, 60, 10)], A4)
    expect(item?.box?.ymax).toBeGreaterThan(0.97)
    expect(item?.box?.ymin).toBeGreaterThan(0.95)
  })

  it('measures the box upward from the baseline', () => {
    // pdf.js reports `y` as the BASELINE and `height` as the glyph height, so
    // the box runs up the page from y — which, flipped, means the baseline is
    // the box's BOTTOM edge.
    const [item] = toPositionedItems([pdfItem('x', 0, 421, 10, 21.05)], A4)
    expect(item?.box?.ymax).toBeCloseTo(0.5, 2)
    expect(item?.box?.ymin).toBeCloseTo(0.475, 2)
  })

  it('subtracts a MediaBox that does not start at the origin', () => {
    const shifted = { view: [100, 200, 695, 1042] as const, rotation: 0 }
    const [item] = toPositionedItems(
      [pdfItem('x', 159.5, 1030, 59.5, 12)],
      shifted,
    )
    expect(item?.box?.xmin).toBeCloseTo(0.1, 3)
    expect(item?.box?.ymin).toBeCloseTo(0, 2)
  })

  it('applies page rotation, so the free path agrees with the rendered page', () => {
    // A /Rotate 90 page renders turned, and the cracked path parses the
    // rendered image. Leaving the text layer untransformed would put its boxes
    // at ninety degrees to the parser's on the very same page.
    const rotated = { view: [0, 0, 595, 842] as const, rotation: 90 }
    const [item] = toPositionedItems([pdfItem('x', 0, 832, 60, 10)], rotated)
    // Top-left in unrotated space becomes top-RIGHT once the page is turned
    // clockwise: high x, low y.
    expect(item?.box?.xmax).toBeCloseTo(1, 2)
    expect(item?.box?.ymin).toBeCloseTo(0, 2)
  })

  it('keeps the text of an item whose geometry is unusable', () => {
    // Losing the item would shift every character offset after it, and the
    // offsets are what map a chunk back onto the page.
    const items = toPositionedItems(
      [pdfItem('no height', 10, 800, 50, 0), pdfItem('fine', 10, 780, 50, 10)],
      A4,
    )
    expect(items.map((i) => i.str)).toEqual(['no height', 'fine'])
    expect(items[0]?.box).toBeNull()
    expect(items[1]?.box).not.toBeNull()
  })

  it('clamps a box that runs off the page rather than reporting > 1', () => {
    const [item] = toPositionedItems([pdfItem('wide', -20, 830, 700, 12)], A4)
    expect(item?.box?.xmin).toBe(0)
    expect(item?.box?.xmax).toBe(1)
  })

  it('survives a page with no usable dimensions', () => {
    const items = toPositionedItems([pdfItem('x', 0, 0, 10, 10)], {
      view: [0, 0, 0, 0],
      rotation: 0,
    })
    expect(items[0]?.box).toBeNull()
  })
})

describe('both paths agree on where a region is', () => {
  it('puts the same heading in the same place either way (FR2)', () => {
    // The text layer's view of a heading 40 units below the top of an A4 page.
    const [fromText] = toPositionedItems(
      [pdfItem('Section 7 - Plant Utilisation', 59.5, 790, 238, 12)],
      A4,
    )

    // The parser's view of the same heading: normalised, top-left, already.
    const element: NormalizedElement = {
      type: 'Section-header',
      text: 'Section 7 - Plant Utilisation',
      bbox: { xmin: 0.1, ymin: 0.048, xmax: 0.5, ymax: 0.062 },
      heading: 'Section 7 - Plant Utilisation',
      caption: null,
      atomic: false,
    }
    const [fromCrack] = chunkElements([element], 1, {
      chunkTokens: 100,
      overlapTokens: 20,
    })

    const text = fromText?.box
    const crack = fromCrack?.bbox
    expect(text).toBeTruthy()
    expect(crack).toBeTruthy()
    expect(text?.xmin).toBeCloseTo(crack?.xmin ?? -1, 2)
    expect(text?.ymin).toBeCloseTo(crack?.ymin ?? -1, 2)
    expect(text?.ymax).toBeCloseTo(crack?.ymax ?? -1, 2)
  })

  it('populates the region list on the cracked path too', () => {
    const element: NormalizedElement = {
      type: 'Table',
      text: 'a | b',
      bbox: { xmin: 0.1, ymin: 0.2, xmax: 0.9, ymax: 0.4 },
      heading: null,
      caption: null,
      atomic: true,
    }
    const [chunk] = chunkElements([element], 3, {
      chunkTokens: 100,
      overlapTokens: 20,
    })
    expect(chunk?.boxes).toEqual([element.bbox])
    expect(chunk?.bbox).toEqual(element.bbox)
  })
})
