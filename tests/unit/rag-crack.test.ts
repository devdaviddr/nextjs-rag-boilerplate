import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The routing, budgeting and degradation rules (spec 0031 FR2, FR11, FR12).
 *
 * `crackDocument` is the one place where a page can cost money, so every
 * branch that decides NOT to spend is pinned here. The parser and the signal
 * collector are mocked: what is under test is the decision sequence, not
 * pdf.js and not the endpoint — both of which are exercised for real against
 * `eval/corpus`.
 */

// `vi.mock` is hoisted above every top-level statement, so the mock's value
// has to be created inside `vi.hoisted` rather than as a plain const above it.
const mockEnv = vi.hoisted(() => ({
  RAG_CRACK_MAX_PAGES: 25,
  RAG_CRACK_ENABLED: true,
  RAG_CHUNK_TOKENS: 512,
  RAG_CHUNK_OVERLAP_TOKENS: 64,
  RAG_DESCRIBE_MAX_FIGURES: 8,
  RAG_CRACK_MIN_FIGURE_AREA: 0.02,
  RAG_CRACK_RENDER_SCALE: 2.0,
}))
vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const collectPageSignals = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rag/signals', () => ({ collectPageSignals }))

const parseRenderedPage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rag/parse', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/rag/parse')>('@/lib/rag/parse')
  return { ...actual, parseRenderedPage }
})

// Rendering is real work against a real PDF; the decision sequence under test
// does not care what the pixels are.
const renderPage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rag/render', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/rag/render')>('@/lib/rag/render')
  return { ...actual, renderPage }
})

// Figure description is covered by its own suite; here it must simply not fire
// for a captioned figure, and not reach the network for anything else.
const describeFigure = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rag/describe', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/rag/describe')>(
      '@/lib/rag/describe',
    )
  return { ...actual, describeFigure }
})

import { crackDocument } from '@/lib/rag/crack'
import { ParseError } from '@/lib/rag/parse'
import type { PageSignals } from '@/lib/rag/triage'

const OPTIONS = { chunkTokens: 512, overlapTokens: 64 }

function cleanSignals(): PageSignals {
  return {
    charCount: 800,
    itemCount: 20,
    imageCount: 0,
    vectorOpCount: 0,
    columnCount: 1,
    textAreaRatio: 0.4,
  }
}

function twoColumnSignals(): PageSignals {
  return { ...cleanSignals(), columnCount: 2 }
}

function scannedSignals(): PageSignals {
  return {
    charCount: 0,
    itemCount: 0,
    imageCount: 1,
    vectorOpCount: 0,
    columnCount: 0,
    textAreaRatio: 0,
  }
}

function element(type: string, text: string) {
  return { type, text, bbox: { xmin: 0.1, ymin: 0.1, xmax: 0.9, ymax: 0.3 } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockEnv.RAG_CRACK_MAX_PAGES = 25
  mockEnv.RAG_DESCRIBE_MAX_FIGURES = 8
  renderPage.mockResolvedValue(Buffer.from('fake-png'))
  describeFigure.mockResolvedValue({ text: 'a bar chart of X', tokens: 10 })
  parseRenderedPage.mockResolvedValue({
    elements: [element('Text', 'Parsed body text.')],
    tokens: 100,
    dropped: 0,
  })
})

describe('crackDocument', () => {
  it('spends nothing on a document of clean-text pages (NFR1)', async () => {
    collectPageSignals.mockResolvedValue([cleanSignals(), cleanSignals()])
    const result = await crackDocument(
      {},
      ['Page one text.', 'Page two text.'],
      OPTIONS,
    )

    expect(parseRenderedPage).not.toHaveBeenCalled()
    expect(result.summary.parseCalls).toBe(0)
    expect(result.summary.pages.every((p) => p.outcome === 'text-layer')).toBe(
      true,
    )
    expect(result.chunks).toHaveLength(2)
  })

  it('cracks only the pages that need it', async () => {
    collectPageSignals.mockResolvedValue([
      cleanSignals(),
      twoColumnSignals(),
      cleanSignals(),
    ])
    const result = await crackDocument({}, ['a', 'b', 'c'], OPTIONS)

    expect(parseRenderedPage).toHaveBeenCalledTimes(1)
    expect(renderPage).toHaveBeenCalledWith({}, 2)
    expect(result.summary.pages.map((p) => p.outcome)).toEqual([
      'text-layer',
      'parsed',
      'text-layer',
    ])
  })

  it('keeps page numbers right when an empty page sits mid-document', async () => {
    // A scanned page contributes an empty string and still needs its slot.
    // Renumbering here would point every later citation at the wrong page.
    collectPageSignals.mockResolvedValue([
      cleanSignals(),
      scannedSignals(),
      cleanSignals(),
    ])
    const result = await crackDocument({}, ['first', '', 'third'], OPTIONS)

    expect(result.summary.pages.map((p) => p.page)).toEqual([1, 2, 3])
    expect(result.chunks.map((c) => c.pageNumber)).toEqual([1, 2, 3])
  })

  it('marks a scanned page ocr, and an ordinary cracked page text', async () => {
    collectPageSignals.mockResolvedValue([scannedSignals(), twoColumnSignals()])
    const result = await crackDocument({}, ['', 'body'], OPTIONS)
    expect(result.chunks.map((c) => c.kind)).toEqual(['ocr', 'text'])
  })

  it('stops at the budget, degrades, and says so (FR11)', async () => {
    mockEnv.RAG_CRACK_MAX_PAGES = 2
    collectPageSignals.mockResolvedValue([
      twoColumnSignals(),
      twoColumnSignals(),
      twoColumnSignals(),
      twoColumnSignals(),
    ])
    const result = await crackDocument({}, ['a', 'b', 'c', 'd'], OPTIONS)

    expect(parseRenderedPage).toHaveBeenCalledTimes(2)
    expect(result.summary.parseCalls).toBe(2)
    expect(result.summary.budgetExhausted).toBe(true)
    expect(result.summary.pages.map((p) => p.outcome)).toEqual([
      'parsed',
      'parsed',
      'budget-skipped',
      'budget-skipped',
    ])
    // Degraded, not dropped: the skipped pages still produced chunks.
    expect(result.chunks).toHaveLength(4)
    expect(result.summary.pages[2]?.reason).toContain('budget')
  })

  it('a budget of zero cracks nothing but still indexes everything', async () => {
    mockEnv.RAG_CRACK_MAX_PAGES = 0
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    const result = await crackDocument({}, ['body text'], OPTIONS)

    expect(parseRenderedPage).not.toHaveBeenCalled()
    expect(result.chunks).toHaveLength(1)
    expect(result.summary.budgetExhausted).toBe(true)
  })

  it('falls back to the text layer when a page fails to parse (FR12)', async () => {
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    parseRenderedPage.mockRejectedValueOnce(new ParseError('parser said no'))

    const result = await crackDocument({}, ['recoverable text'], OPTIONS)

    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0]?.content).toBe('recoverable text')
    expect(result.summary.pages[0]?.outcome).toBe('failed')
    expect(result.summary.pages[0]?.reason).toContain('text layer')
  })

  it('records a failed page with no text layer as not indexed', async () => {
    collectPageSignals.mockResolvedValue([scannedSignals()])
    parseRenderedPage.mockRejectedValueOnce(new ParseError('parser said no'))

    const result = await crackDocument({}, [''], OPTIONS)

    expect(result.chunks).toHaveLength(0)
    expect(result.summary.pages[0]?.reason).toContain('not indexed')
  })

  it('lets an unexpected error fail loudly rather than degrading silently', async () => {
    // A ParseError means "this page resisted"; a TypeError means the pipeline
    // is broken, and quietly indexing the text layer would hide a real bug
    // behind slightly worse search results.
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    parseRenderedPage.mockRejectedValueOnce(
      new TypeError('undefined is not a function'),
    )

    await expect(crackDocument({}, ['text'], OPTIONS)).rejects.toThrow(
      TypeError,
    )
  })

  it('reports progress after every page, cracked or not (FR13)', async () => {
    collectPageSignals.mockResolvedValue([
      cleanSignals(),
      twoColumnSignals(),
      cleanSignals(),
    ])
    const seen: number[] = []
    await crackDocument({}, ['a', 'b', 'c'], {
      ...OPTIONS,
      onPageProcessed: (n) => {
        seen.push(n)
      },
    })
    expect(seen).toEqual([1, 2, 3])
  })

  it('numbers chunks monotonically across mixed pages', async () => {
    collectPageSignals.mockResolvedValue([
      cleanSignals(),
      twoColumnSignals(),
      cleanSignals(),
    ])
    parseRenderedPage.mockResolvedValue({
      elements: [element('Text', 'one'), element('Table', 'two')],
      tokens: 10,
      dropped: 0,
    })
    const result = await crackDocument({}, ['a', 'b', 'c'], OPTIONS)
    expect(result.chunks.map((c) => c.chunkIndex)).toEqual(
      result.chunks.map((_, i) => i),
    )
  })

  it('describes a caption-less figure, and never a captioned one (FR6)', async () => {
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    parseRenderedPage.mockResolvedValue({
      elements: [
        // A caption is the document's own words and costs nothing.
        {
          type: 'Picture',
          text: 'Q1 Q2 Q3',
          bbox: { xmin: 0.1, ymin: 0.1, xmax: 0.8, ymax: 0.6 },
        },
        {
          type: 'Caption',
          text: 'Figure 1 — quarterly downtime',
          bbox: { xmin: 0.1, ymin: 0.6, xmax: 0.8, ymax: 0.65 },
        },
        // This one has nothing to be found by.
        {
          type: 'Picture',
          text: '',
          bbox: { xmin: 0.1, ymin: 0.7, xmax: 0.8, ymax: 0.95 },
        },
      ],
      tokens: 10,
      dropped: 0,
    })

    const result = await crackDocument({}, ['body'], OPTIONS)

    // The empty-text Picture is dropped by normalisation before it can be
    // described, so exactly the captioned one survives — and it cost nothing.
    expect(describeFigure).not.toHaveBeenCalled()
    const figure = result.chunks.find((c) => c.kind === 'figure')
    expect(figure?.caption).toContain('quarterly downtime')
    expect(result.summary.describeCalls).toBe(0)
  })

  it('skips a Picture too small to be a figure', async () => {
    // A logo, a rule, a bullet glyph. Describing one spends the most expensive
    // call in the system on furniture.
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    parseRenderedPage.mockResolvedValue({
      elements: [
        {
          type: 'Picture',
          text: 'logo',
          bbox: { xmin: 0.9, ymin: 0.02, xmax: 0.97, ymax: 0.06 },
        },
        element('Text', 'Body text.'),
      ],
      tokens: 10,
      dropped: 0,
    })

    const result = await crackDocument({}, ['body'], OPTIONS)

    expect(result.chunks.some((c) => c.kind === 'figure')).toBe(false)
    expect(describeFigure).not.toHaveBeenCalled()
  })

  it('stops describing when the per-document budget runs out', async () => {
    mockEnv.RAG_DESCRIBE_MAX_FIGURES = 1
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    parseRenderedPage.mockResolvedValue({
      elements: [
        {
          type: 'Picture',
          text: 'first',
          bbox: { xmin: 0.05, ymin: 0.05, xmax: 0.9, ymax: 0.4 },
        },
        {
          type: 'Picture',
          text: 'second',
          bbox: { xmin: 0.05, ymin: 0.5, xmax: 0.9, ymax: 0.9 },
        },
      ],
      tokens: 10,
      dropped: 0,
    })

    const result = await crackDocument({}, ['body'], OPTIONS)

    expect(describeFigure).toHaveBeenCalledTimes(1)
    expect(result.summary.describeCalls).toBe(1)
    // Both figures still index — the second simply has no description.
    const figures = result.chunks.filter((c) => c.kind === 'figure')
    expect(figures).toHaveLength(2)
    expect(figures.filter((f) => f.caption).length).toBe(1)
  })

  it('indexes a figure even when describing it fails', async () => {
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    describeFigure.mockResolvedValueOnce(null)
    parseRenderedPage.mockResolvedValue({
      elements: [
        {
          type: 'Picture',
          text: 'Q1 Q2',
          bbox: { xmin: 0.05, ymin: 0.05, xmax: 0.9, ymax: 0.5 },
        },
      ],
      tokens: 10,
      dropped: 0,
    })

    const result = await crackDocument({}, ['body'], OPTIONS)
    const figure = result.chunks.find((c) => c.kind === 'figure')
    expect(figure).toBeDefined()
    expect(figure?.caption).toBeNull()
  })
})
