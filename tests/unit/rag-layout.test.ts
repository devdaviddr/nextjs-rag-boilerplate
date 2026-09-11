import { describe, expect, it } from 'vitest'

import type { PositionedItem } from '@/lib/rag/chunk'
import {
  type LayoutLine,
  bodyFontSize,
  classifyLines,
  documentLayout,
  findFurniture,
  toElements,
  toLines,
} from '@/lib/rag/layout'

/**
 * Spec 0039. The sizes here are the ones measured on `rag-cracking-test`:
 * body 10.5, section headers 12.5, the title 17, running header and footer
 * 7.5. Keeping the real numbers means a threshold that stops working on a real
 * document stops working here too.
 */

const PAGE_HEIGHT = 792

/** A line's worth of items, positioned as a PDF of this size would report. */
function item(
  str: string,
  {
    size,
    top,
    endsLine = true,
  }: { size: number; top: number; endsLine?: boolean },
): PositionedItem {
  return {
    str,
    box: {
      xmin: 0.09,
      ymin: top,
      xmax: 0.89,
      ymax: top + size / PAGE_HEIGHT,
    },
    fontSize: size,
    endsLine,
  }
}

function line(text: string, size: number, top: number): LayoutLine {
  return {
    text,
    bbox: { xmin: 0.09, ymin: top, xmax: 0.89, ymax: top + size / PAGE_HEIGHT },
    fontSize: size,
  }
}

/** One page of the measured document, as lines. */
function reportPage(n: number): LayoutLine[] {
  return [
    line('NORTHBRIDGE UTILITIES · INTERNAL · ASSET REPORT FY26', 7.5, 0.02),
    line(`${n}. A section`, 12.5, 0.1),
    line('Body text on the page, of ordinary length and size.', 10.5, 0.2),
    line(`Confidential — Page ${n} of 7 — Rev 4`, 7.5, 0.71),
  ]
}

describe('toLines', () => {
  it('uses the PDF’s own end-of-line rather than inferring one', () => {
    const lines = toLines([
      item('Plant Asset', { size: 17, top: 0.06, endsLine: false }),
      item(' Report', { size: 17, top: 0.06 }),
      item('1. Purpose', { size: 12.5, top: 0.12 }),
    ])
    expect(lines.map((l) => l.text)).toEqual([
      'Plant Asset Report',
      '1. Purpose',
    ])
  })

  it('weights a line’s size by characters, so one stray glyph cannot set it', () => {
    const [only] = toLines([
      item('a'.repeat(50), { size: 10.5, top: 0.2, endsLine: false }),
      item('!', { size: 30, top: 0.2 }),
    ])
    expect(only?.fontSize).toBeGreaterThan(10)
    expect(only?.fontSize).toBeLessThan(11)
  })

  it('reports no size when the PDF reported none', () => {
    const [only] = toLines([
      { str: 'text', box: { xmin: 0.1, ymin: 0.1, xmax: 0.5, ymax: 0.12 } },
    ])
    expect(only?.fontSize).toBeNull()
  })
})

describe('bodyFontSize', () => {
  it('is the size carrying the most characters, not the most lines', () => {
    const pages = [
      [
        line('A', 20, 0.1),
        line('B', 20, 0.2),
        line('C', 20, 0.3),
        line('body text that is much longer than any of those', 10.5, 0.4),
      ],
    ]
    expect(bodyFontSize(pages)).toBe(10.5)
  })

  it('treats 10.4999995 and 10.5 as one size', () => {
    expect(
      bodyFontSize([[line('aaaa', 10.4999995, 0.1), line('bbbb', 10.5, 0.2)]]),
    ).toBe(10.5)
  })

  it('is null when nothing reported a size', () => {
    expect(
      bodyFontSize([[{ ...line('x', 10, 0.1), fontSize: null }]]),
    ).toBeNull()
  })
})

describe('findFurniture', () => {
  it('finds a running header and a paginated footer', () => {
    const pages = [reportPage(1), reportPage(2), reportPage(3)]
    const furniture = findFurniture(pages, 10.5)
    // The page number is masked, or a paginated footer repeats zero times.
    expect([...furniture]).toEqual([
      'top:northbridge utilities · internal · asset report fy#',
      'bottom:confidential — page # of # — rev #',
    ])
  })

  it('finds a footer that sits well above the bottom margin', () => {
    // The measured case: content stops early and the footer sits at 71% down
    // the page. Position by rank finds it; an absolute margin band does not.
    const furniture = findFurniture([reportPage(1), reportPage(2)], 10.5)
    expect([...furniture].some((k) => k.startsWith('bottom:'))).toBe(true)
  })

  it('never calls a one-page document’s first line furniture', () => {
    expect(findFurniture([reportPage(1)], 10.5).size).toBe(0)
  })

  it('refuses to treat a repeated line larger than body text as furniture', () => {
    // A short document whose every page opens with the same section title.
    // Dropping it would unindex the thing a reader searches by.
    const pages = [
      [line('Appendix', 14, 0.02), line('body body body', 10.5, 0.2)],
      [line('Appendix', 14, 0.02), line('more body text', 10.5, 0.2)],
    ]
    expect(findFurniture(pages, 10.5).size).toBe(0)
  })

  it('refuses to treat a long repeated line as furniture', () => {
    const long = 'x'.repeat(240)
    const pages = [
      [line(long, 9, 0.02), line('body', 10.5, 0.2)],
      [line(long, 9, 0.02), line('body', 10.5, 0.2)],
    ]
    expect(findFurniture(pages, 10.5).size).toBe(0)
  })
})

describe('classifyLines', () => {
  // `bodySize` is a document-level fact, so a three-line fixture must be told
  // it rather than allowed to derive "body" from its own headings.
  const context = (pages: LayoutLine[][], bodySize = 10.5) => ({
    bodySize,
    furniture: findFurniture(pages, bodySize),
  })

  it('separates title, heading, body and furniture at the measured sizes', () => {
    const page = [
      line('NORTHBRIDGE UTILITIES · INTERNAL · ASSET REPORT FY26', 7.5, 0.02),
      line('Plant Asset Report', 17, 0.06),
      line(
        'Prepared for the Facilities Committee · 10 September 2026',
        9,
        0.09,
      ),
      line('1. Purpose', 12.5, 0.13),
      line(
        'This report summarises the condition of mechanical plant.',
        10.5,
        0.2,
      ),
      line('Confidential — Page 1 of 7 — Rev 4', 7.5, 0.71),
    ]
    const pages = [page, page]
    expect(classifyLines(page, context(pages)).map((c) => c.type)).toEqual([
      'Page-header',
      'Title',
      'Text',
      'Section-header',
      'Text',
      'Page-footer',
    ])
  })

  it('names a caption by what it calls itself', () => {
    const page = [
      line('Table 8.1 — Cutover waves. Wave 3 proceeds only if…', 8.5, 0.3),
      line('Figure 6.1: Unplanned downtime by quarter.', 8.5, 0.4),
      line('Tables are useful things in reports.', 10.5, 0.5),
    ]
    expect(classifyLines(page, context([page])).map((c) => c.type)).toEqual([
      'Caption',
      'Caption',
      // No number, so not a caption — this is a sentence about tables.
      'Text',
    ])
  })

  it('will not promote a long line to a heading however large it is set', () => {
    const page = [
      line('x'.repeat(200), 20, 0.1),
      line('body text here', 10.5, 0.3),
    ]
    expect(classifyLines(page, context([page]))[0]?.type).toBe('Text')
  })

  it('leaves everything as text when no size was reported', () => {
    const page = [
      { ...line('Looks Like A Heading', 17, 0.06), fontSize: null },
      { ...line('body', 10.5, 0.2), fontSize: null },
    ]
    expect(classifyLines(page, context([page])).map((c) => c.type)).toEqual([
      'Text',
      'Text',
    ])
  })
})

describe('toElements', () => {
  const context = (pages: LayoutLine[][], bodySize = 10.5) => ({
    bodySize,
    furniture: findFurniture(pages, bodySize),
  })

  it('runs consecutive body lines into one paragraph', () => {
    const page = [
      line('This report summarises the condition of the plant', 10.5, 0.2),
      line('across the estate. It is the reference document.', 10.5, 0.2159),
      line('Heading Here', 12.5, 0.26),
    ]
    const elements = toElements(page, context([page]))
    expect(elements).toHaveLength(2)
    expect(elements[0]?.text).toContain('across the estate')
    expect(elements[1]?.type).toBe('Section-header')
  })

  it('splits a paragraph at a blank line', () => {
    const page = [
      line('First paragraph.', 10.5, 0.2),
      line('Second paragraph, after a blank line.', 10.5, 0.25),
    ]
    expect(toElements(page, context([page]))).toHaveLength(2)
  })

  it('splits where a column ends rather than merging across the break', () => {
    // The measured failure: the foot of the left column and the head of the
    // right are a large NEGATIVE gap, which reads as "no gap at all".
    const page = [
      line('Building A was recommissioned in March.', 10.5, 0.6),
      line('Building B was recommissioned in August.', 10.5, 0.2),
    ]
    const elements = toElements(page, context([page]))
    expect(elements).toHaveLength(2)
    expect(elements[1]?.text).toContain('Building B')
  })

  it('never merges two headings into one', () => {
    const page = [
      line('8. Shutdown schedule', 12.5, 0.2),
      line('9. Sign-off', 12.5, 0.2159),
    ]
    expect(toElements(page, context([page]))).toHaveLength(2)
  })
})

describe('documentLayout', () => {
  it('derives body size and furniture once for the whole document', () => {
    const items = (n: number): PositionedItem[] => [
      item('NORTHBRIDGE UTILITIES · INTERNAL · ASSET REPORT FY26', {
        size: 7.5,
        top: 0.02,
      }),
      item(`${n}. A section`, { size: 12.5, top: 0.1 }),
      item(
        'Body text of ordinary length and ordinary size, of which a real page carries a great deal more than it carries running heads.',
        { size: 10.5, top: 0.2 },
      ),
      item(`Confidential — Page ${n} of 7 — Rev 4`, { size: 7.5, top: 0.71 }),
    ]
    const { layout, linesByPage } = documentLayout([items(1), items(2)])
    expect(layout.bodySize).toBe(10.5)
    expect(layout.furniture.size).toBe(2)
    expect(linesByPage).toHaveLength(2)

    // And the furniture is gone from what gets indexed.
    const elements = toElements(linesByPage[0]!, layout)
    expect(elements.map((e) => e.type)).toEqual([
      'Page-header',
      'Section-header',
      'Text',
      'Page-footer',
    ])
  })
})
