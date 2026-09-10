import { describe, expect, it } from 'vitest'

import { boxPercentStyle, toCitationBoxes } from '@/lib/citations/boxes'

/**
 * Spec 0035: "no box is strictly better than a wrong box". Every case here is
 * about that asymmetry — a rectangle is drawn only when the stored data is
 * unambiguous, and everything else degrades to the page-level citation the
 * panel gave before this spec.
 */
describe('toCitationBoxes', () => {
  it('returns no boxes for a chunk ingested before boxes existed (FR4)', () => {
    expect(toCitationBoxes(null)).toEqual([])
    expect(toCitationBoxes(undefined)).toEqual([])
  })

  it('accepts a single stored box, the shape spec 0031 shipped', () => {
    expect(
      toCitationBoxes({ xmin: 0.1, ymin: 0.2, xmax: 0.9, ymax: 0.3 }),
    ).toEqual([{ xmin: 0.1, ymin: 0.2, xmax: 0.9, ymax: 0.3 }])
  })

  it('keeps a two-column chunk as two boxes, never their union (FR6)', () => {
    const left = { xmin: 0.05, ymin: 0.1, xmax: 0.45, ymax: 0.9 }
    const right = { xmin: 0.55, ymin: 0.1, xmax: 0.95, ymax: 0.4 }

    const boxes = toCitationBoxes([left, right])

    expect(boxes).toEqual([left, right])
    // The union would span the gutter and cover the wrong column outright.
    expect(boxes.some((b) => b.xmin < 0.5 && b.xmax > 0.5)).toBe(false)
  })

  it('drops an inverted box rather than repairing it into a plausible one', () => {
    // Measured in real parser output on 2026-09-10: xmin 0.031 > xmax 0.022.
    expect(
      toCitationBoxes({ xmin: 0.031, ymin: 0.1, xmax: 0.022, ymax: 0.2 }),
    ).toEqual([])
  })

  it('drops a zero-area box, which cites a point and not a passage', () => {
    expect(
      toCitationBoxes({ xmin: 0.4, ymin: 0.4, xmax: 0.4, ymax: 0.6 }),
    ).toEqual([])
  })

  it('drops a box that is not on the page', () => {
    expect(
      toCitationBoxes({ xmin: -0.5, ymin: 0.1, xmax: 0.4, ymax: 0.2 }),
    ).toEqual([])
    expect(
      toCitationBoxes({ xmin: 0.1, ymin: 0.1, xmax: 1.6, ymax: 0.2 }),
    ).toEqual([])
  })

  it('tolerates a rounding artefact at the page edge and clamps it', () => {
    expect(
      toCitationBoxes({ xmin: -0.005, ymin: 0.1, xmax: 1.004, ymax: 0.2 }),
    ).toEqual([{ xmin: 0, ymin: 0.1, xmax: 1, ymax: 0.2 }])
  })

  it('drops a non-numeric or malformed entry without losing its siblings', () => {
    const good = { xmin: 0.1, ymin: 0.1, xmax: 0.2, ymax: 0.2 }

    expect(
      toCitationBoxes([
        'not a box',
        null,
        { xmin: 0.1, ymin: 0.1, xmax: 'wide', ymax: 0.2 },
        { xmin: Number.NaN, ymin: 0.1, xmax: 0.2, ymax: 0.2 },
        good,
      ]),
    ).toEqual([good])
  })

  it('collapses exact duplicates, which would stack into a darker box', () => {
    const box = { xmin: 0.1, ymin: 0.1, xmax: 0.2, ymax: 0.2 }
    expect(toCitationBoxes([box, { ...box }, box])).toEqual([box])
  })

  it('never throws on a shape nothing in this system produces', () => {
    expect(toCitationBoxes(42)).toEqual([])
    expect(toCitationBoxes('{}')).toEqual([])
    expect(toCitationBoxes({ page: 3 })).toEqual([])
  })
})

describe('boxPercentStyle', () => {
  it('positions a box as percentages of the rendered page', () => {
    const style = boxPercentStyle({
      xmin: 0.25,
      ymin: 0.5,
      xmax: 0.75,
      ymax: 0.6,
    })

    expect(style.left).toBe('25%')
    expect(style.top).toBe('50%')
    expect(style.width).toBe('50%')
    // Float arithmetic, not a rounded value: the CSS is what it is, and at a
    // page's width a 1e-14 difference is far below a pixel.
    expect(Number.parseFloat(style.height)).toBeCloseTo(10, 6)
  })
})
