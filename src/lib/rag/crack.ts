import 'server-only'

import type { ChunkKind, ExtractionPage, ExtractionSummary } from '@/db/schema'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { type Chunk, chunkElements, chunkPages } from './chunk'
import type { PageText } from './chunk'
import { extractPdf } from './extract'
import { describeFigure, isDescribableFigure } from './describe'
import { type NormalizedElement, normalizePage } from './normalize'
import { ParseError, parseRenderedPage } from './parse'
import type { ParsedElement } from './parse-types'
import { RenderError, renderPage } from './render'
import { collectPageSignals } from './signals'
import { type PageRoute, classifyPage, requiresCracking } from './triage'

/**
 * The routed, budgeted cracking pass (spec 0031 FR1, FR2, FR11, FR12).
 *
 * Sits between extraction and embedding, and its contract is narrow on
 * purpose: given an open PDF and the text layer already pulled from it, return
 * the chunks for the whole document plus an honest record of how each page was
 * read. It never writes to the database and never embeds — `ingest.ts` owns
 * both, so this stays testable as a unit and reusable for a re-crack later.
 *
 * ## Degrade, never fail
 *
 * Every failure path here ends in "this page was read the cheap way", recorded
 * with a reason. A page that cannot be cracked must not fail its document:
 * a 200-page report is not worthless because page 149 is a corrupt scan. The
 * only thing that fails a document is having no readable text at all, and that
 * decision belongs to the caller.
 */

/** How the chunks for one document were produced. */
export interface CrackResult {
  chunks: Chunk[]
  summary: ExtractionSummary
}

/** Text-layer chunks for a single page, continuing the document's sequence. */
function textLayerChunks(
  page: PageText,
  startIndex: number,
  options: { chunkTokens: number; overlapTokens: number },
): Chunk[] {
  return chunkPages([page], options).map((chunk, i) => ({
    ...chunk,
    chunkIndex: startIndex + i,
  }))
}

/**
 * Somewhere durable to keep a page's parser output between runs (spec 0034).
 *
 * A port, not a table: `crack.ts` never touches the database — that is the
 * contract in this module's header, and it is what keeps the whole routing and
 * budgeting sequence unit-testable with no DB and no network. `ingest.ts`
 * supplies the Postgres-backed implementation; `eval/run.ts` supplies none and
 * behaves exactly as it did before.
 *
 * Both methods are best-effort by construction. A cache that throws must never
 * fail a document — the worst a miss can do is cost a parse call.
 */
export interface ParsedPageCache {
  get(page: number): Promise<ParsedElement[] | null>
  set(page: number, elements: readonly ParsedElement[]): Promise<void>
}

export interface CrackOptions {
  chunkTokens: number
  overlapTokens: number
  /** Used to give a caption-less figure context in its description. */
  documentTitle?: string
  /**
   * Called after each page, so ingestion can report progress (FR13) and
   * persist the partial record (spec 0034). The second argument is the summary
   * *so far* — a truthful account of the pages done, which is what a run
   * interrupted here leaves behind on the document row.
   */
  onPageProcessed?: (
    pagesProcessed: number,
    summarySoFar: ExtractionSummary,
  ) => Promise<void> | void
  /** Absent means "never resume" — every routed page pays for its parse. */
  parseCache?: ParsedPageCache
  signal?: AbortSignal
}

/**
 * Give every caption-less figure on a page a search key.
 *
 * A figure WITH a caption already has one, for free, in the document's own
 * words — so it is skipped. Only the rest cost a vision call, and only while
 * the per-document budget lasts. Measured at ~40s each, which is why this is
 * the tightest budget in the system and why the caption shortcut matters more
 * than it looks.
 *
 * Returns the elements with descriptions folded into `caption`, because that is
 * already the field `chunkElements` and `buildEmbeddingText` read — a figure's
 * search key comes from one place regardless of which way it was obtained.
 */
async function describeFigures(
  elements: readonly NormalizedElement[],
  {
    png,
    documentTitle,
    remainingBudget,
    signal,
  }: {
    png: Buffer
    documentTitle: string
    remainingBudget: number
    signal?: AbortSignal
  },
): Promise<{ elements: NormalizedElement[]; calls: number }> {
  let budget = remainingBudget
  const out: NormalizedElement[] = []
  let calls = 0

  for (const element of elements) {
    if (element.type !== 'Picture' || element.caption || budget <= 0) {
      out.push(element)
      continue
    }

    budget--
    calls++
    const described = await describeFigure(
      {
        png,
        bbox: element.bbox,
        documentTitle,
        heading: element.heading,
        printedText: element.text,
      },
      { signal },
    )

    out.push(described ? { ...element, caption: described.text } : element)
  }

  return { elements: out, calls }
}

/**
 * Cache access that can never fail a document.
 *
 * A cache is an optimisation, and an optimisation that can take down an
 * ingestion is a downgrade. A read that throws is a miss; a write that throws
 * costs a re-parse on the next attempt and nothing else. Both are logged,
 * because a cache that is silently always missing looks exactly like a cache
 * that is working and would hide the regression this spec exists to fix.
 */
async function readCache(
  cache: ParsedPageCache | undefined,
  page: number,
): Promise<ParsedElement[] | null> {
  if (!cache) return null
  try {
    const hit = await cache.get(page)
    return hit && hit.length > 0 ? hit : null
  } catch (error) {
    logger.warn('Parse cache read failed', {
      page,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

async function writeCache(
  cache: ParsedPageCache | undefined,
  page: number,
  elements: readonly ParsedElement[],
): Promise<void> {
  if (!cache || elements.length === 0) return
  try {
    await cache.set(page, elements)
  } catch (error) {
    logger.warn('Parse cache write failed', {
      page,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Crack a document, page by page.
 *
 * `pageTexts` must be the FULL page sequence including empty pages — a scanned
 * page contributes an empty string and still needs a slot, or every page after
 * it is numbered wrong and every citation from that document points at the
 * wrong page.
 */
export async function crackDocument(
  pdf: unknown,
  pageTexts: readonly string[],
  options: CrackOptions,
): Promise<CrackResult> {
  const {
    chunkTokens,
    overlapTokens,
    onPageProcessed,
    parseCache,
    signal,
    documentTitle = '',
  } = options

  const signals = await collectPageSignals(pdf, pageTexts)
  const routes: PageRoute[] = signals.map((s) => classifyPage(s))

  const chunks: Chunk[] = []
  const pages: ExtractionPage[] = []
  let parseCalls = 0
  let describeCalls = 0
  let cachedPages = 0
  let budgetExhausted = false

  const summarySoFar = (): ExtractionSummary => ({
    pages: [...pages],
    parseCalls,
    describeCalls,
    cachedPages,
    budgetExhausted,
  })

  for (const [index, route] of routes.entries()) {
    const pageNumber = index + 1
    const page: PageText = {
      pageNumber,
      text: (pageTexts[index] ?? '').trim(),
    }

    const record = (outcome: ExtractionPage['outcome'], reason?: string) => {
      pages.push(
        reason
          ? { page: pageNumber, route, outcome, reason }
          : { page: pageNumber, route, outcome },
      )
    }

    // The free path: either the page does not need help, or the budget is
    // spent. Both produce text-layer chunks; only the reason differs, and the
    // reason is what makes a partially-cracked document honest.
    if (!requiresCracking(route)) {
      chunks.push(...textLayerChunks(page, chunks.length, options))
      record('text-layer')
      await onPageProcessed?.(pageNumber, summarySoFar())
      continue
    }

    // A cache hit still spends budget. The budget decides WHICH pages of a
    // document get cracked, so if a resumed run got its first 25 pages free
    // and then cracked 15 more, it would produce a different — more
    // expensive — document than the uninterrupted run it is resuming. The
    // resume must be invisible in the output, not just cheaper.
    if (parseCalls >= env.RAG_CRACK_MAX_PAGES) {
      budgetExhausted = true
      chunks.push(...textLayerChunks(page, chunks.length, options))
      record(
        'budget-skipped',
        `Document reached its ${env.RAG_CRACK_MAX_PAGES}-page cracking budget.`,
      )
      await onPageProcessed?.(pageNumber, summarySoFar())
      continue
    }

    try {
      parseCalls++

      // Rendering is local (pdf.js) and parsing is a billed call, so the cache
      // is checked first and the page is rendered only if something still
      // needs its pixels — a resumed page with no caption-less figure on it
      // costs neither.
      let png: Buffer | null = null
      const renderOnce = async (): Promise<Buffer> =>
        (png ??= await renderPage(pdf, pageNumber))

      let elements = await readCache(parseCache, pageNumber)
      if (elements) {
        cachedPages++
      } else {
        elements = (
          await parseRenderedPage(await renderOnce(), pageNumber, {
            signal,
          })
        ).elements
        // Written before the page's chunks exist, and outside every
        // transaction: this is the record that survives the process dying
        // three pages later, which is the entire point of it.
        await writeCache(parseCache, pageNumber, elements)
      }

      const normalised = normalizePage(elements).filter(
        // A logo or a rule is a `Picture` too. Dropping it here keeps a chunk
        // that could only ever be a false positive out of the knowledge base.
        (element) =>
          element.type !== 'Picture' || isDescribableFigure(element.bbox),
      )

      const describeBudget = env.RAG_DESCRIBE_MAX_FIGURES - describeCalls
      const wantsDescription = normalised.some(
        (element) =>
          element.type === 'Picture' && !element.caption && describeBudget > 0,
      )
      const described = wantsDescription
        ? await describeFigures(normalised, {
            // Reused for the crop when the page was parsed above; rendered now
            // when it came from cache.
            png: await renderOnce(),
            documentTitle,
            remainingBudget: describeBudget,
            signal,
          })
        : { elements: normalised, calls: 0 }
      describeCalls += described.calls

      // A page with no text layer was read from its pixels; saying so lets a
      // citation distinguish "the document says" from "we read this off a
      // scan", which are different claims about the same words.
      const textKind: ChunkKind = route === 'no-text' ? 'ocr' : 'text'
      chunks.push(
        ...chunkElements(described.elements, pageNumber, {
          chunkTokens,
          overlapTokens,
          startIndex: chunks.length,
          textKind,
        }),
      )
      record('parsed')
    } catch (error) {
      const expected =
        error instanceof ParseError || error instanceof RenderError
      if (!expected) throw error

      // Fall back to whatever the text layer holds. For a `no-text` page that
      // is nothing, and the page is recorded as unindexed rather than silently
      // contributing zero chunks — which is the failure this spec exists for.
      const fallback = textLayerChunks(page, chunks.length, options)
      chunks.push(...fallback)
      record(
        'failed',
        fallback.length > 0
          ? `${error.message} Read from the text layer instead.`
          : `${error.message} This page is not indexed.`,
      )
      logger.warn('Page cracking failed', {
        pageNumber,
        route,
        error: error.message,
        indexed: fallback.length > 0,
      })
    }

    await onPageProcessed?.(pageNumber, summarySoFar())
  }

  return { chunks, summary: summarySoFar() }
}

/** Pages this document would spend a parse call on, before spending any. */
export async function planCracking(
  pdf: unknown,
  pageTexts: readonly string[],
): Promise<{ routes: PageRoute[]; crackablePages: number }> {
  const signals = await collectPageSignals(pdf, pageTexts)
  const routes = signals.map((s) => classifyPage(s))
  return { routes, crackablePages: routes.filter(requiresCracking).length }
}

export interface DocumentChunks {
  chunks: Chunk[]
  pageCount: number
  /** Absent when cracking is off — there is nothing to report. */
  extraction?: ExtractionSummary
}

/**
 * PDF bytes to chunks, by whichever path `RAG_CRACK_ENABLED` selects.
 *
 * **The single definition of how a document becomes chunks**, deliberately.
 * `eval/run.ts` used to carry its own copy of this sequence so it could ingest
 * without object storage, and the copy silently stopped matching production the
 * moment cracking existed: the harness reported no improvement because it was
 * still measuring the old pipeline. An evaluation that does not run the code
 * being evaluated is worse than no evaluation, so both callers come through
 * here now.
 */
export async function chunksFromPdf(
  buffer: Buffer,
  options: CrackOptions,
): Promise<DocumentChunks> {
  const cracking = env.RAG_CRACK_ENABLED
  const { pages, pageCount, allPageTexts, pdf } = await extractPdf(buffer, {
    allowImageOnly: cracking,
  })

  if (!cracking) {
    return { chunks: chunkPages(pages, options), pageCount }
  }

  const { chunks, summary } = await crackDocument(pdf, allPageTexts, options)
  return { chunks, pageCount, extraction: summary }
}
