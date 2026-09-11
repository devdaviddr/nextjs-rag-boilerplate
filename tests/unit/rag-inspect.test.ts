import { describe, expect, it } from 'vitest'

import type { ExtractionSummary } from '@/db/schema'
import type { CitationBox } from '@/lib/citations/boxes'
import {
  type InspectedChunk,
  buildInspection,
  describeKind,
  describePage,
  indexingCompleteness,
} from '@/lib/rag/inspect'

/**
 * Spec 0037: "an inspection tool that rounds up is worse than none". Every
 * case here is about the direction of the errors — the view is allowed to be
 * vague, and is never allowed to make the index look more complete than it is.
 */

function summary(
  pages: ExtractionSummary['pages'],
  overrides: Partial<ExtractionSummary> = {},
): ExtractionSummary {
  return {
    pages,
    parseCalls: 0,
    describeCalls: 0,
    budgetExhausted: false,
    ...overrides,
  }
}

function chunk(
  page: number,
  overrides: Partial<InspectedChunk> = {},
): InspectedChunk & { pageNumber: number } {
  return {
    id: `c${page}`,
    kind: 'text',
    content: 'text',
    heading: null,
    caption: null,
    tokenCount: 10,
    chunkIndex: page,
    boxes: [] as CitationBox[],
    headingBox: null,
    captionBox: null,
    embeddedText: 'doc\ntext',
    pageNumber: page,
    ...overrides,
  }
}

describe('describePage', () => {
  it('names a failed page as not indexed and passes the recorded reason through (FR3, FR6)', () => {
    const d = describePage({
      route: 'no-text',
      outcome: 'failed',
      reason: 'Parser found no elements. This page is not indexed.',
    })
    expect(d.indexed).toBe(false)
    expect(d.headline).toBe('Not indexed')
    expect(d.detail).toContain('not indexed')
  })

  it('never renders the stored enum (FR3)', () => {
    const routes = [
      'clean-text',
      'structured',
      'image-heavy',
      'no-text',
    ] as const
    for (const route of routes) {
      const { headline } = describePage({ route, outcome: 'parsed' })
      expect(headline).not.toContain(route)
      expect(headline).not.toMatch(/parsed|text-layer|budget-skipped/)
    }
  })

  it('distinguishes a budget-skipped page from a fully read one (FR3)', () => {
    const skipped = describePage({
      route: 'structured',
      outcome: 'budget-skipped',
    })
    const read = describePage({ route: 'structured', outcome: 'parsed' })
    expect(skipped.headline).not.toBe(read.headline)
    // Still indexed — degraded, not missing. 0031 FR11 chose that deliberately.
    expect(skipped.indexed).toBe(true)
  })

  it('says the routing is unrecorded rather than inventing one (FR8)', () => {
    const d = describePage({})
    expect(d.headline).toMatch(/not recorded/i)
    expect(d.indexed).toBe(true)
  })
})

describe('describeKind', () => {
  it('says what a figure chunk actually holds, and what it does not (FR5)', () => {
    // The content is the text printed inside the figure, so calling it "not
    // the document's own words" was wrong in the other direction. What must
    // never be implied is that the figure itself was read into the index.
    const { label, note } = describeKind('figure')
    expect(label).toBe('Figure')
    expect(note).toMatch(/printed inside/i)
    expect(note).toMatch(/not stored here/i)
  })

  it('labels OCR text as recovered from an image (FR5)', () => {
    expect(describeKind('ocr').note).toMatch(/image/i)
  })

  it('leaves plain text unqualified — a note there would dilute the ones that matter', () => {
    expect(describeKind('text')).toEqual({ label: 'Text' })
  })
})

describe('indexingCompleteness', () => {
  const twoPages = new Map([
    [1, [chunk(1)]],
    [2, [chunk(2)]],
  ])

  it('calls a fully indexed document complete', () => {
    const extraction = summary([
      { page: 1, route: 'clean-text', outcome: 'text-layer' },
      { page: 2, route: 'clean-text', outcome: 'text-layer' },
    ])
    expect(indexingCompleteness(extraction, twoPages)).toEqual({
      partial: false,
      reasons: [],
    })
  })

  it('flags a failed page and names it (FR7)', () => {
    const extraction = summary([
      { page: 1, route: 'clean-text', outcome: 'text-layer' },
      { page: 2, route: 'no-text', outcome: 'failed', reason: 'no elements' },
    ])
    const { partial, reasons } = indexingCompleteness(
      extraction,
      new Map([[1, [chunk(1)]]]),
    )
    expect(partial).toBe(true)
    // Which page, not just how many — a bare count is not actionable.
    expect(reasons.join(' ')).toContain('page 2')
  })

  it('flags an exhausted budget even when every page succeeded (FR7)', () => {
    const extraction = summary(
      [
        { page: 1, route: 'clean-text', outcome: 'text-layer' },
        { page: 2, route: 'structured', outcome: 'budget-skipped' },
      ],
      { budgetExhausted: true },
    )
    expect(indexingCompleteness(extraction, twoPages).partial).toBe(true)
  })

  it('flags a page that succeeded but produced nothing — the silent failure (FR7)', () => {
    const extraction = summary([
      { page: 1, route: 'clean-text', outcome: 'text-layer' },
      { page: 2, route: 'clean-text', outcome: 'text-layer' },
    ])
    const { partial, reasons } = indexingCompleteness(
      extraction,
      new Map([[1, [chunk(1)]]]),
    )
    expect(partial).toBe(true)
    expect(reasons.join(' ')).toMatch(/nothing searchable/i)
  })

  it('claims nothing about a document with no record (FR8)', () => {
    expect(indexingCompleteness(null, new Map())).toEqual({
      partial: false,
      reasons: [],
    })
  })
})

describe('buildInspection', () => {
  it('lists a page that produced no chunks — the whole point of the view (FR6)', () => {
    const result = buildInspection({
      pageCount: 2,
      extraction: summary([
        { page: 1, route: 'clean-text', outcome: 'text-layer' },
        { page: 2, route: 'no-text', outcome: 'failed', reason: 'no elements' },
      ]),
      chunks: [chunk(1)],
    })

    expect(result.pages.map((p) => p.page)).toEqual([1, 2])
    const page2 = result.pages[1]!
    expect(page2.chunks).toEqual([])
    expect(page2.empty).toBe(true)
    expect(page2.reason).toBe('no elements')
    expect(result.partial).toBe(true)
  })

  it('is driven by the extraction record, not by the chunks', () => {
    // A page with chunks but no record still appears — dropping it would hide
    // indexed content — but the page list's shape comes from the record.
    const result = buildInspection({
      pageCount: 3,
      extraction: summary([
        { page: 1, route: 'clean-text', outcome: 'text-layer' },
      ]),
      chunks: [chunk(1)],
    })
    expect(result.pages).toHaveLength(1)
  })

  it('falls back to the page count with no record, and says so (FR8)', () => {
    const result = buildInspection({
      pageCount: 3,
      extraction: null,
      chunks: [chunk(2)],
    })
    expect(result.pages.map((p) => p.page)).toEqual([1, 2, 3])
    expect(result.extraction).toBeNull()
    for (const page of result.pages) {
      expect(page.route).toBeUndefined()
      expect(page.outcome).toBeUndefined()
    }
    // Nothing is known about routing, so nothing is claimed about completeness.
    expect(result.partial).toBe(false)
  })

  it('carries the heading, which is indexed but never a chunk of its own', () => {
    // `normalizePage` consumes heading elements, so a heading has no box and
    // nothing on the page marks it — while `buildEmbeddingText` prepends it
    // before embedding. Dropping it here would say it was not indexed.
    const result = buildInspection({
      pageCount: 1,
      extraction: summary([
        { page: 1, route: 'clean-text', outcome: 'text-layer' },
      ]),
      chunks: [chunk(1, { heading: '1. Purpose' })],
    })
    expect(result.pages[0]!.chunks[0]!.heading).toBe('1. Purpose')
  })

  it('draws one heading region however many chunks sit under it (0038 FR4)', () => {
    const box = { xmin: 0.1, ymin: 0.1, xmax: 0.5, ymax: 0.15 }
    const result = buildInspection({
      pageCount: 1,
      extraction: summary([
        { page: 1, route: 'clean-text', outcome: 'text-layer' },
      ]),
      chunks: [
        chunk(1, { id: 'a', heading: '1. Purpose', headingBox: box }),
        chunk(1, { id: 'b', heading: '1. Purpose', headingBox: box }),
      ],
    })
    // Two chunks, one rectangle — stacked outlines read as emphasis.
    expect(result.pages[0]!.annotations).toEqual([
      { kind: 'heading', text: '1. Purpose', box },
    ])
  })

  it('keeps two same-named headings that sit in different places', () => {
    const result = buildInspection({
      pageCount: 1,
      extraction: summary([
        { page: 1, route: 'clean-text', outcome: 'text-layer' },
      ]),
      chunks: [
        chunk(1, {
          id: 'a',
          heading: 'Notes',
          headingBox: { xmin: 0.1, ymin: 0.1, xmax: 0.4, ymax: 0.14 },
        }),
        chunk(1, {
          id: 'b',
          heading: 'Notes',
          headingBox: { xmin: 0.1, ymin: 0.6, xmax: 0.4, ymax: 0.64 },
        }),
      ],
    })
    expect(result.pages[0]!.annotations).toHaveLength(2)
  })

  it('marks a caption region and never invents one (FR4, FR7)', () => {
    const result = buildInspection({
      pageCount: 2,
      extraction: summary([
        { page: 1, route: 'image-heavy', outcome: 'parsed' },
        { page: 2, route: 'image-heavy', outcome: 'parsed' },
      ]),
      chunks: [
        chunk(1, {
          id: 'a',
          kind: 'figure',
          caption: 'Figure 6.1 — downtime by quarter',
          captionBox: { xmin: 0.1, ymin: 0.8, xmax: 0.9, ymax: 0.84 },
        }),
        // Ingested before the column existed: a caption it never recorded must
        // not become a rectangle drawn from nothing.
        chunk(2, { id: 'b', kind: 'figure' }),
      ],
    })
    expect(result.pages[0]!.annotations).toEqual([
      {
        kind: 'caption',
        text: 'Figure 6.1 — downtime by quarter',
        box: { xmin: 0.1, ymin: 0.8, xmax: 0.9, ymax: 0.84 },
      },
    ])
    expect(result.pages[1]!.annotations).toEqual([])
  })

  it('orders chunks by their position in the document, not by id', () => {
    const result = buildInspection({
      pageCount: 1,
      extraction: summary([
        { page: 1, route: 'clean-text', outcome: 'text-layer' },
      ]),
      chunks: [
        // Alphabetical by id gives the opposite order, so this only passes if
        // the document's own sequence is what is used.
        { ...chunk(1, { id: 'aaa' }), chunkIndex: 1 },
        { ...chunk(1, { id: 'zzz' }), chunkIndex: 0 },
      ],
    })
    expect(result.pages[0]!.chunks.map((c) => c.id)).toEqual(['zzz', 'aaa'])
  })

  it('groups every chunk under its own page', () => {
    const result = buildInspection({
      pageCount: 2,
      extraction: summary([
        { page: 1, route: 'clean-text', outcome: 'text-layer' },
        { page: 2, route: 'image-heavy', outcome: 'parsed' },
      ]),
      chunks: [
        chunk(1, { id: 'a' }),
        chunk(2, { id: 'b', kind: 'figure' }),
        chunk(1, { id: 'c' }),
      ],
    })
    expect(result.pages[0]!.chunks.map((c) => c.id)).toEqual(['a', 'c'])
    expect(result.pages[1]!.chunks.map((c) => c.id)).toEqual(['b'])
  })
})
