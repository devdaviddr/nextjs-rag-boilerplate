import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Resuming a partly-cracked document (spec 0034 FR3).
 *
 * The measurement this exists for: with cracking on, ingestion is one parse
 * call per routed page, and an 8-page document took 51 seconds. Before this,
 * a container restart at page 20 of 25 threw away all twenty and started again
 * from page 1, because `crackDocument` holds its output in memory and only the
 * final transaction persists anything.
 *
 * What is under test is therefore narrow and specific: which pages reach the
 * parser on the second run, and what the second run's document looks like
 * compared with the first's. The parser, renderer and signal collector are
 * mocked — see `rag-crack.test.ts`, which pins the routing decisions.
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

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({ logger: loggerMock }))

const collectPageSignals = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rag/signals', () => ({ collectPageSignals }))

const parseRenderedPage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rag/parse', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/rag/parse')>('@/lib/rag/parse')
  return { ...actual, parseRenderedPage }
})

const renderPage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rag/render', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/rag/render')>('@/lib/rag/render')
  return { ...actual, renderPage }
})

const describeFigure = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rag/describe', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/rag/describe')>(
      '@/lib/rag/describe',
    )
  return { ...actual, describeFigure }
})

import { type ParsedPageCache, crackDocument } from '@/lib/rag/crack'
import type { ParsedElement } from '@/lib/rag/parse-types'
import type { PageSignals } from '@/lib/rag/triage'

const OPTIONS = { chunkTokens: 512, overlapTokens: 64 }

/** A page the router will always want cracked. */
function twoColumnSignals(): PageSignals {
  return {
    charCount: 800,
    itemCount: 20,
    imageCount: 0,
    vectorOpCount: 0,
    columnCount: 2,
    textAreaRatio: 0.4,
  }
}

function element(type: string, text: string): ParsedElement {
  return { type, text, bbox: { xmin: 0.1, ymin: 0.1, xmax: 0.9, ymax: 0.3 } }
}

/** An in-memory stand-in for the `parsed_pages` table. */
function memoryCache(seed: Map<number, ParsedElement[]> = new Map()) {
  const store = new Map(seed)
  const cache: ParsedPageCache = {
    get: vi.fn(async (page: number) => store.get(page) ?? null),
    set: vi.fn(async (page: number, elements: readonly ParsedElement[]) => {
      store.set(page, [...elements])
    }),
  }
  return { cache, store }
}

const pages = (n: number) =>
  Array.from({ length: n }, (_, i) => `page ${i + 1}`)

beforeEach(() => {
  vi.clearAllMocks()
  mockEnv.RAG_CRACK_MAX_PAGES = 25
  mockEnv.RAG_DESCRIBE_MAX_FIGURES = 8
  renderPage.mockResolvedValue(Buffer.from('fake-png'))
  parseRenderedPage.mockImplementation(async (_png: Buffer, page: number) => ({
    elements: [element('Text', `Parsed body of page ${page}.`)],
    tokens: 100,
    dropped: 0,
  }))
})

describe('the parse cache', () => {
  it('is filled page by page, so an interruption keeps what was bought', async () => {
    collectPageSignals.mockResolvedValue([
      twoColumnSignals(),
      twoColumnSignals(),
    ])
    const { cache, store } = memoryCache()

    // The run dies on page 2, exactly as a container restart would kill it.
    parseRenderedPage.mockImplementationOnce(async () => ({
      elements: [element('Text', 'Parsed body of page 1.')],
      tokens: 100,
      dropped: 0,
    }))
    parseRenderedPage.mockImplementationOnce(async () => {
      throw new Error('process died')
    })

    await expect(
      crackDocument({}, pages(2), { ...OPTIONS, parseCache: cache }),
    ).rejects.toThrow('process died')

    // Page 1 survives the death of the run that paid for it. Nothing else in
    // the pipeline persists anything until the final transaction, which is why
    // this write has to happen here rather than at the end.
    expect(store.get(1)).toEqual([element('Text', 'Parsed body of page 1.')])
  })

  it('serves a resumed page without touching the parser', async () => {
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    const { cache } = memoryCache(
      new Map([[1, [element('Text', 'Parsed body of page 1.')]]]),
    )

    const result = await crackDocument({}, pages(1), {
      ...OPTIONS,
      parseCache: cache,
    })

    expect(parseRenderedPage).not.toHaveBeenCalled()
    expect(result.summary.cachedPages).toBe(1)
    // The outcome is `parsed` either way: how the elements were obtained is not
    // a fact about the document, and a citation must not depend on it.
    expect(result.summary.pages[0]?.outcome).toBe('parsed')
    expect(result.chunks[0]?.content).toContain('Parsed body of page 1.')
  })

  it('re-pays for only the pages that were never bought', async () => {
    // The acceptance criterion, in miniature: 25 pages, 20 already cracked.
    collectPageSignals.mockResolvedValue(
      Array.from({ length: 25 }, () => twoColumnSignals()),
    )
    const seed = new Map(
      Array.from({ length: 20 }, (_, i) => [
        i + 1,
        [element('Text', `Parsed body of page ${i + 1}.`)],
      ]),
    )
    const { cache } = memoryCache(seed)

    const result = await crackDocument({}, pages(25), {
      ...OPTIONS,
      parseCache: cache,
    })

    expect(parseRenderedPage).toHaveBeenCalledTimes(5)
    expect(
      parseRenderedPage.mock.calls.map((call) => call[1] as number),
    ).toEqual([21, 22, 23, 24, 25])
    expect(result.summary.cachedPages).toBe(20)
    // All 25 pages are still in the document. Resuming is about what a run
    // pays for, never about what it produces.
    expect(result.summary.pages).toHaveLength(25)
  })

  it('does not render a cached page with nothing left to look at', async () => {
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    const { cache } = memoryCache(new Map([[1, [element('Text', 'Body.')]]]))

    await crackDocument({}, pages(1), { ...OPTIONS, parseCache: cache })

    // Rendering is local, so this is time rather than money — but a page whose
    // pixels nobody needs should not be rasterised at 2x for nothing.
    expect(renderPage).not.toHaveBeenCalled()
  })

  it('renders a cached page that still has a figure to describe', async () => {
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    describeFigure.mockResolvedValue({ text: 'a bar chart of X', tokens: 10 })
    const { cache } = memoryCache(
      new Map([
        [
          1,
          [
            {
              type: 'Picture',
              text: 'figure 1',
              bbox: { xmin: 0.05, ymin: 0.05, xmax: 0.9, ymax: 0.6 },
            },
          ],
        ],
      ]),
    )

    const result = await crackDocument({}, pages(1), {
      ...OPTIONS,
      parseCache: cache,
    })

    // Descriptions are deliberately NOT cached — they depend on the prompt and
    // the vision model, not only on the pixels — so the crop still needs the
    // page, and the page still needs rendering.
    expect(renderPage).toHaveBeenCalledTimes(1)
    expect(result.summary.describeCalls).toBe(1)
  })
})

describe('the cracking budget under resume', () => {
  it('is spent by a cached page too, so a resumed run is not a bigger one', async () => {
    // Budget 2 over 3 crackable pages, with the first two already cached. If a
    // cache hit were free, this run would crack all three and quietly produce a
    // more expensive document than the run it is resuming — the resume would
    // stop being invisible in the output.
    mockEnv.RAG_CRACK_MAX_PAGES = 2
    collectPageSignals.mockResolvedValue([
      twoColumnSignals(),
      twoColumnSignals(),
      twoColumnSignals(),
    ])
    const { cache } = memoryCache(
      new Map([
        [1, [element('Text', 'Parsed body of page 1.')]],
        [2, [element('Text', 'Parsed body of page 2.')]],
      ]),
    )

    const result = await crackDocument({}, pages(3), {
      ...OPTIONS,
      parseCache: cache,
    })

    expect(parseRenderedPage).not.toHaveBeenCalled()
    expect(result.summary.budgetExhausted).toBe(true)
    expect(result.summary.pages[2]?.outcome).toBe('budget-skipped')
  })
})

describe('when the cache itself misbehaves', () => {
  it('treats a failing read as a miss', async () => {
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    const cache: ParsedPageCache = {
      get: vi.fn(async () => {
        throw new Error('connection reset')
      }),
      set: vi.fn(async () => {}),
    }

    const result = await crackDocument({}, pages(1), {
      ...OPTIONS,
      parseCache: cache,
    })

    // An optimisation that can fail a document is a downgrade. The worst a
    // broken cache may cost is a parse call.
    expect(parseRenderedPage).toHaveBeenCalledTimes(1)
    expect(result.summary.pages[0]?.outcome).toBe('parsed')
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Parse cache read failed',
      expect.objectContaining({ page: 1 }),
    )
  })

  it('treats a failing write as nothing at all', async () => {
    collectPageSignals.mockResolvedValue([twoColumnSignals()])
    const cache: ParsedPageCache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error('disk full')
      }),
    }

    const result = await crackDocument({}, pages(1), {
      ...OPTIONS,
      parseCache: cache,
    })

    expect(result.chunks.length).toBeGreaterThan(0)
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Parse cache write failed',
      expect.objectContaining({ page: 1 }),
    )
  })
})

describe('progress reporting', () => {
  it('hands ingestion the summary so far, not just a page number', async () => {
    collectPageSignals.mockResolvedValue([
      twoColumnSignals(),
      twoColumnSignals(),
    ])
    const seen: { page: number; recorded: number }[] = []

    await crackDocument({}, pages(2), {
      ...OPTIONS,
      onPageProcessed: (page, summarySoFar) => {
        seen.push({ page, recorded: summarySoFar.pages.length })
      },
    })

    // A run interrupted after page 1 therefore leaves a truthful partial
    // record on the document row, rather than nothing until the very end.
    expect(seen).toEqual([
      { page: 1, recorded: 1 },
      { page: 2, recorded: 2 },
    ])
  })
})
