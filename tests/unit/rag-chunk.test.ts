import { describe, expect, it } from 'vitest'

import {
  buildEmbeddingText,
  chunkPages,
  detectHeading,
  estimateTokens,
  type PageText,
  type PositionedItem,
} from '@/lib/rag/chunk'

const OPTS = { chunkTokens: 100, overlapTokens: 20 }

function page(pageNumber: number, text: string): PageText {
  return { pageNumber, text }
}

/**
 * Real token counts, straight from the embedding endpoint's own `usage`
 * frames — `nvidia/nemotron-3-embed-1b`, one `/embeddings` call per sample,
 * 2026-09-11. Five of the fifteen samples the estimator was calibrated
 * against, one per shape that behaves differently.
 *
 * These are the numbers spec 0033's first acceptance criterion asks for. They
 * are recorded rather than fetched: a unit test that needs an API key and a
 * rate-limited shared account is not a unit test.
 */
const MEASURED: { kind: string; tokens: number; text: string }[] = [
  {
    kind: 'prose',
    tokens: 117,
    text: 'STAFF HANDBOOK - SECTION 1 - ANNUAL LEAVE\nPolicy reference POL-HR-014.\nThe annual leave entitlement is 20 working days per calendar year.\nUnused leave does not carry over into the following year.\nLeave must be approved by your manager at least two weeks in advance.\nLeave requests during the December shutdown are not accepted.\n\nSTAFF HANDBOOK - SECTION 2 - EXPENSES\nPolicy reference POL-FIN-022.\nRei',
  },
  {
    kind: 'table (latex)',
    tokens: 145,
    text: '\\begin{tabular}{ccccc}\n\\multirow{2}{*}{**Plant**} & \\multicolumn{2}{c}{**Utilisation %**} & \\multicolumn{2}{c}{**Downtime (hrs)**}\\\\\n & **H1** & **H2** & **Planned** & **Unplanned**\\\\\nBallarat & 71.4 & 88.2 & 140 & 96\\\\\nGeelong & 63.0 & 61.5 & 210 & 388\\\\\nBendigo & 84.9 & 86.1 & 95 & 41\\\\\n\\end{tabular}',
  },
  {
    kind: 'table (formulae)',
    tokens: 118,
    text: '\\begin{tabular}{lcc}\n**Metric** & **Definition** & **FY26**\\\\\nOEE & \\(A \\times P \\times Q\\) & 0.742\\\\\nMTBF & \\(\\frac{\\sum t_{up}}{n_{f}}\\) & 318.5 h\\\\\nMTTR & \\(\\frac{\\sum t_{down}}{n_{f}}\\) & 4.1 h\\\\\nAvailability & \\(\\frac{t_{up}}{t_{up}+t_{down}}\\) & 98.7 \\%\\\\\n\\end{tabular}',
  },
  {
    kind: 'table (pipes)',
    tokens: 284,
    text: '| Plant | Utilisation % | Downtime (hrs) | Incidents |\n| --- | --- | --- | --- |\n| Ballarat | 55.0 | 120 | 0 |\n| Geelong | 58.1 | 137 | 1 |\n| Bendigo | 61.2 | 154 | 2 |\n| Shepparton | 64.3 | 171 | 3 |\n| Mildura | 67.4 | 188 | 4 |\n| Horsham | 70.5 | 205 | 0 |\n| Warrnambool | 73.6 | 222 | 1 |\n| Sale | 76.7 | 239 | 2 |\n| Ballarat | 79.8 | 256 | 3 |\n| Geelong | 82.9 | 273 | 4 |\n| Bendigo | 86.0 | 290 | 0 |\n| Shepparton | 89.1 | 307 | 1 |\n| Mildura | 92.2 | 324 | 2 |\n| Horsham | 95.3 | 341 | 3 |',
  },
  {
    kind: 'ocr',
    tokens: 179,
    text: 'STAFF HANDBOOK - SECTION 1 - ANNUAL LEAVE\n Policy ref- erence POL-HR-014.\n The annual . leave entitlement is 20 wor- king days per calendar year.\n Unused leave does not carry over . into the following year.\n Leave must be approved by your manager at 1east two weeks in advance.\n Leave requests during the December shutdown are . not accepted.\n \n STAFF HANDBOOK - SECTION 2 - EXPENSES\n Policy reference POL-FIN-022.\n Reimbursement for travel . must be submitted within 30 days of the trip.\n Original . receipts must be attached to every claim.\n Claims over 500 dollars require . directcr approval bef- ore payment.\n Mileage is reim',
  },
]

describe('estimateTokens', () => {
  it('is zero for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it.each(MEASURED)(
    'is within 15% of the provider\u2019s own count on $kind',
    ({ tokens, text }) => {
      // 15%, not "a few percent": this is a calibration, not the model's
      // vocabulary, and spec 0033 says so. The bound is the measured worst
      // case (9.5%) plus room for the samples it was not fitted on.
      const error = Math.abs(estimateTokens(text) - tokens) / tokens
      expect(error).toBeLessThan(0.15)
    },
  )

  it.each(MEASURED.filter((m) => m.kind.startsWith('table')))(
    'no longer halves $kind the way length/4 did',
    ({ tokens, text }) => {
      // The regression this replaces: at ~2 characters per token, table markup
      // measured by `length / 4` came out 36–60% short, so a "512-token" chunk
      // of it was really about a thousand.
      expect(Math.ceil(text.length / 4)).toBeLessThan(tokens * 0.7)
      expect(estimateTokens(text)).toBeGreaterThan(tokens * 0.85)
    },
  )

  it('charges more for a digit than for a letter', () => {
    // Why a numeric table is so much denser than it looks: a digit costs a
    // token each, where six or so letters share one.
    expect(estimateTokens('20260911202609')).toBeGreaterThan(
      estimateTokens('abcdefghijklmn'),
    )
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

/**
 * Boxes on the text-layer path (spec 0035 FR1, FR2, FR6).
 *
 * The items are written the way `extractText` builds a page: the page's text
 * IS the concatenation of the items' strings, which is what makes the mapping
 * from a chunk's characters back to its items exact.
 */
function line(
  str: string,
  [xmin, ymin, xmax, ymax]: [number, number, number, number],
): PositionedItem {
  return { str, box: { xmin, ymin, xmax, ymax } }
}

/** A page whose text is exactly what its items say, joined by newlines. */
function positionedPage(pageNumber: number, items: PositionedItem[]): PageText {
  return {
    pageNumber,
    text: items.map((i) => i.str).join('\n'),
    items: items.map((i, index) =>
      index === items.length - 1 ? i : { ...i, str: `${i.str}\n` },
    ),
  }
}

/** Left column and right column of the same three visual lines, interleaved
 *  the way pdf.js emits a two-column page — left, right, left, right. */
function twoColumnPage(): PageText {
  return positionedPage(1, [
    line('The north wing lift was upgraded', [0.1, 0.12, 0.35, 0.134]),
    line('The south wing lift remains on', [0.54, 0.12, 0.79, 0.134]),
    line('in February by Hartley.', [0.1, 0.14, 0.33, 0.154]),
    line('the original controller.', [0.54, 0.14, 0.78, 0.154]),
    line('Its new capacity is 1600 kg.', [0.1, 0.16, 0.31, 0.174]),
    line('Its capacity is unchanged.', [0.54, 0.16, 0.78, 0.174]),
  ])
}

describe('chunkPages boxes', () => {
  it('gives every chunk of a positioned page a box (FR1)', () => {
    const chunks = chunkPages(
      [
        positionedPage(1, [
          line('ANNUAL LEAVE', [0.1, 0.06, 0.5, 0.075]),
          line('The entitlement is 20 days.', [0.1, 0.08, 0.6, 0.095]),
          line('Unused leave does not carry over.', [0.1, 0.1, 0.62, 0.115]),
        ]),
      ],
      OPTS,
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.boxes).toHaveLength(1)
    expect(chunks[0]?.bbox).toEqual({
      xmin: 0.1,
      ymin: 0.06,
      xmax: 0.62,
      ymax: 0.115,
    })
  })

  it('keeps the top-left convention the cracked path already uses (FR2)', () => {
    // The first line of the page is at the TOP, so its ymin is small. PDF's
    // own space is bottom-left; the flip happens once, at extraction.
    const chunks = chunkPages(
      [
        positionedPage(1, [
          line('TOP OF THE PAGE', [0.1, 0.05, 0.5, 0.07]),
          line('and then a footer at the bottom.', [0.1, 0.9, 0.5, 0.92]),
        ]),
      ],
      OPTS,
    )
    const boxes = chunks[0]?.boxes ?? []
    expect(boxes[0]?.ymin).toBeLessThan(0.1)
    expect(boxes.at(-1)?.ymin).toBeGreaterThan(0.8)
    // Two regions a page apart are not one rectangle, so the single-box
    // field stays null rather than covering everything between them.
    expect(chunks[0]?.bbox ?? null).toBeNull()
  })

  it('records two boxes for a two-column chunk, never their union (FR6)', () => {
    const chunks = chunkPages([twoColumnPage()], OPTS)
    expect(chunks).toHaveLength(1)

    const boxes = chunks[0]?.boxes ?? []
    expect(boxes).toHaveLength(2)
    // One box per column, and the gutter between 0.35 and 0.54 is in neither.
    expect(boxes[0]?.xmax).toBeLessThanOrEqual(0.36)
    expect(boxes[1]?.xmin).toBeGreaterThanOrEqual(0.53)
    // And the single-box field refuses rather than covering both columns —
    // no box beats a wrong box.
    expect(chunks[0]?.bbox ?? null).toBeNull()
  })

  it('tracks down the page as chunks advance', () => {
    const chunks = chunkPages(
      [
        positionedPage(1, [
          line('First line of the page here.', [0.1, 0.1, 0.6, 0.12]),
          line('Second line of the page here.', [0.1, 0.2, 0.6, 0.22]),
          line('Third line of the page here.', [0.1, 0.3, 0.6, 0.32]),
        ]),
      ],
      // A budget small enough to force one chunk per line.
      { chunkTokens: 12, overlapTokens: 2 },
    )
    expect(chunks.length).toBeGreaterThan(1)
    const tops = chunks.map((c) => c.bbox?.ymin ?? -1)
    expect(tops.every((y) => y >= 0)).toBe(true)
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i] as number).toBeGreaterThan(tops[i - 1] as number)
    }
  })

  it('leaves a chunk boxless when the page has no items (FR4)', () => {
    const chunks = chunkPages([page(1, 'A page with no text layer items.')], {
      ...OPTS,
    })
    expect(chunks[0]?.boxes).toBeUndefined()
    expect(chunks[0]?.bbox).toBeUndefined()
  })

  it('leaves a chunk boxless when the items do not match the text', () => {
    // The cracked path hands `chunkPages` a page string with no items of its
    // own; a mismatch must degrade to page-level, silently and without error.
    const chunks = chunkPages(
      [
        {
          pageNumber: 1,
          text: 'Text that came from somewhere else entirely.',
          items: [line('Unrelated item text.', [0.1, 0.1, 0.5, 0.12])],
        },
      ],
      OPTS,
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.boxes).toBeUndefined()
  })

  it('keeps an item with no usable geometry in the character sequence', () => {
    // An item whose box pdf.js could not compute still contributes its text.
    // Dropping it would shift every offset after it and mislocate the rest.
    const chunks = chunkPages(
      [
        {
          pageNumber: 1,
          text: 'Boxless start. Then a located line.',
          items: [
            { str: 'Boxless start. ', box: null },
            line('Then a located line.', [0.1, 0.3, 0.6, 0.32]),
          ],
        },
      ],
      OPTS,
    )
    expect(chunks[0]?.boxes).toEqual([
      { xmin: 0.1, ymin: 0.3, xmax: 0.6, ymax: 0.32 },
    ])
  })

  it('still never lets a chunk span a page boundary when boxed', () => {
    const chunks = chunkPages(
      [
        positionedPage(1, [line('Alpha.', [0.1, 0.1, 0.3, 0.12])]),
        positionedPage(2, [line('Beta.', [0.1, 0.1, 0.3, 0.12])]),
      ],
      OPTS,
    )
    expect(chunks.map((c) => c.pageNumber)).toEqual([1, 2])
    expect(chunks[0]?.content).not.toContain('Beta')
  })
})

describe('detectHeading', () => {
  it('detects an all-caps section heading', () => {
    expect(
      detectHeading('STAFF HANDBOOK - SECTION 2 - EXPENSES\nClaims...'),
    ).toBe('STAFF HANDBOOK - SECTION 2 - EXPENSES')
  })

  it('detects a title-case heading', () => {
    expect(detectHeading('Notice And Termination\nAfter probation...')).toBe(
      'Notice And Termination',
    )
  })

  it('refuses a sentence, however short', () => {
    // Promoting a sentence to a heading prepends it to every chunk on the page
    // and pollutes their embeddings, so the detector prefers to miss.
    expect(detectHeading('The building is open from 6am.')).toBeNull()
    expect(detectHeading('Leave must be approved:')).toBeNull()
  })

  it('refuses an over-long first line', () => {
    expect(detectHeading('A '.repeat(60))).toBeNull()
  })

  it('handles empty and symbol-only pages', () => {
    expect(detectHeading('')).toBeNull()
    expect(detectHeading('   \n  ')).toBeNull()
    expect(detectHeading('--- ***')).toBeNull()
  })
})

describe('buildEmbeddingText', () => {
  it('prefixes the document title so a title mention has something to match', () => {
    const text = buildEmbeddingText({
      documentTitle: 'staff-handbook',
      heading: 'SECTION 1 - ANNUAL LEAVE',
      content: 'The entitlement is 20 days.',
    })
    expect(text).toContain('staff handbook')
    expect(text).toContain('SECTION 1 - ANNUAL LEAVE')
    expect(text).toContain('The entitlement is 20 days.')
  })

  it('normalises separators in the title', () => {
    expect(
      buildEmbeddingText({
        documentTitle: 'q3_financial-report',
        heading: null,
        content: 'x',
      }),
    ).toContain('q3 financial report')
  })

  it('omits the heading when there is none', () => {
    const text = buildEmbeddingText({
      documentTitle: 'doc',
      heading: null,
      content: 'body',
    })
    expect(text).toBe('doc\nbody')
  })

  it('never mutates the content itself', () => {
    // The stored content is what a citation shows; the preamble is only ever
    // part of the embedded text.
    const content = 'Original wording, unchanged.'
    expect(
      buildEmbeddingText({ documentTitle: 'd', heading: 'H', content }),
    ).toContain(content)
  })
})
