import type { ChunkKind, ExtractionPage, ExtractionSummary } from '@/db/schema'
import type { CitationBox } from '@/lib/citations/boxes'

/**
 * Turning what ingestion recorded into something a user can read (spec 0037).
 *
 * Pure and dependency-free so the honesty decisions are unit-testable without a
 * database — which matters more here than usual, because every one of them is a
 * decision about what NOT to hide.
 *
 * ## The bias this module exists to resist
 *
 * A document's row says `Ready · 8 pages · 21 chunks` and stops, while
 * `documents.extraction` records that page 8 was never indexed and why. Every
 * temptation in an inspection view runs one way: drop the empty page because it
 * looks like a rendering bug, show a figure's search key as though it were the
 * document's caption, treat a missing extraction record as "fine". A tool that
 * rounds up is worse than no tool, because it converts a silent gap into one the
 * user has actively been reassured about.
 */

/** One chunk, as the inspector needs it. */
export interface InspectedChunk {
  id: string
  kind: ChunkKind
  content: string
  /**
   * The section heading this chunk sits under, resolved at ingestion.
   *
   * Carried because it is INDEXED: `buildEmbeddingText` prepends the document
   * title and this heading before embedding, so a question naming a section
   * matches through it. `normalizePage` consumes heading elements rather than
   * emitting them, so a heading is never a chunk of its own and never has a
   * box — which makes it look, on this page, like it was never indexed at all.
   * Showing it is the difference between that impression and the truth.
   */
  heading: string | null
  tokenCount: number
  /** Regions on the page, already reconciled from `boxes`/`bbox`. */
  boxes: CitationBox[]
}

/** A page, whether or not anything was indexed from it. */
export interface InspectedPage {
  page: number
  chunks: InspectedChunk[]
  /** Absent for documents ingested before `extraction` existed (FR8). */
  route?: ExtractionPage['route']
  outcome?: ExtractionPage['outcome']
  reason?: string
  /** True when nothing on this page is searchable (FR6). */
  empty: boolean
}

export interface InspectedDocument {
  pages: InspectedPage[]
  /** Null when ingestion recorded no routing detail (FR8). */
  extraction: ExtractionSummary | null
  /** See `indexingCompleteness`. */
  partial: boolean
  partialReasons: string[]
}

/**
 * How a page was read, in the user's language rather than the enum.
 *
 * The stored vocabulary (`clean-text`, `structured`, `budget-skipped`) is
 * internal, and its meaning is the entire thing being communicated — a raw enum
 * would satisfy FR3's letter and none of its purpose.
 */
export function describePage(page: {
  route?: ExtractionPage['route']
  outcome?: ExtractionPage['outcome']
  reason?: string
}): { headline: string; detail?: string; indexed: boolean } {
  const { route, outcome, reason } = page

  if (!outcome) {
    return {
      headline: 'How this page was read was not recorded',
      detail:
        'It was indexed before the app kept a per-page record, or with page-by-page reading turned off.',
      indexed: true,
    }
  }

  if (outcome === 'failed') {
    return {
      headline: 'Not indexed',
      // The recorded reason is written for a user already; passing it through
      // beats paraphrasing it into something vaguer.
      detail: reason ?? 'This page could not be read.',
      indexed: false,
    }
  }

  if (outcome === 'budget-skipped') {
    return {
      headline: 'Read the quick way',
      detail:
        reason ??
        'This document reached its page budget, so the rest was read from the text layer only.',
      indexed: true,
    }
  }

  if (outcome === 'text-layer') {
    return { headline: "Read from the page's own text", indexed: true }
  }

  // outcome === 'parsed' — the route says why it was worth a page-by-page read.
  const byRoute: Record<string, string> = {
    'no-text': 'Scanned page, read with OCR',
    structured: 'Read page by page — it has columns or a table',
    'image-heavy': 'Read page by page — it has figures',
    'clean-text': 'Read page by page',
  }
  return {
    headline: byRoute[route ?? ''] ?? 'Read page by page',
    indexed: true,
  }
}

/**
 * What a chunk's stored text actually IS.
 *
 * `figure` is the one that matters. Since spec 0031 its content is a **search
 * key** — a caption, or a generated label — written so the figure can be found
 * and explicitly NOT the document's words. Rendering it unlabelled beside real
 * extracted text would present a generated sentence as a quotation, which is the
 * single most misleading thing this view could do.
 */
export function describeKind(kind: ChunkKind): {
  label: string
  note?: string
} {
  switch (kind) {
    case 'figure':
      return {
        label: 'Figure',
        note: 'Written so the figure can be found — not the document’s own words.',
      }
    case 'ocr':
      return {
        label: 'Scanned text',
        note: 'Recovered from an image of the page, so it may contain reading errors.',
      }
    case 'table':
      return {
        label: 'Table',
        note: 'Stored with its structure, so columns stay attached to their headers.',
      }
    default:
      return { label: 'Text' }
  }
}

/**
 * Is this document fully indexed, and if not, why not (FR7)?
 *
 * Derived from the recorded outcomes rather than stored as a column: a second
 * source of truth would drift from the first, and the first is already written
 * at the only moment that knows the answer.
 */
/**
 * "page 8", not "(8)" — a bare number in brackets beside a count reads as
 * another count, and the whole value of the reason is knowing which page.
 */
function pageList(pages: readonly number[]): string {
  const label = pages.length === 1 ? 'page' : 'pages'
  if (pages.length <= 6) return `${label} ${pages.join(', ')}`
  return `${label} ${pages.slice(0, 6).join(', ')} and ${pages.length - 6} more`
}

export function indexingCompleteness(
  extraction: ExtractionSummary | null,
  chunksByPage: ReadonlyMap<number, unknown[]>,
): { partial: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!extraction) return { partial: false, reasons }

  const failed = extraction.pages.filter((p) => p.outcome === 'failed')
  if (failed.length > 0) {
    reasons.push(
      `${failed.length} page${failed.length === 1 ? '' : 's'} could not be read — ${pageList(failed.map((p) => p.page))}`,
    )
  }

  if (extraction.budgetExhausted) {
    reasons.push(
      'This document reached its page budget, so some pages were read the quick way',
    )
  }

  // A page that produced nothing is not searchable even when its outcome looks
  // successful — the failure spec 0031 was written about looked exactly like
  // this from the outside.
  const silent = extraction.pages.filter(
    (p) =>
      p.outcome !== 'failed' && (chunksByPage.get(p.page)?.length ?? 0) === 0,
  )
  if (silent.length > 0) {
    reasons.push(
      `${silent.length} page${silent.length === 1 ? '' : 's'} produced nothing searchable — ${pageList(silent.map((p) => p.page))}`,
    )
  }

  return { partial: reasons.length > 0, reasons }
}

/**
 * Assemble the view model.
 *
 * **Driven by `extraction.pages`, never by the chunks.** A page that produced
 * nothing contributes no chunk rows, so building the page list from chunks would
 * make exactly the pages this feature exists to reveal invisible. Chunks are
 * joined onto the page record, not the other way round.
 */
export function buildInspection(input: {
  pageCount: number | null
  extraction: ExtractionSummary | null
  chunks: readonly (InspectedChunk & { pageNumber: number })[]
}): InspectedDocument {
  const { pageCount, extraction, chunks } = input

  const byPage = new Map<number, InspectedChunk[]>()
  for (const c of chunks) {
    const list = byPage.get(c.pageNumber) ?? []
    list.push(c)
    byPage.set(c.pageNumber, list)
  }

  // FR8: with no record, fall back to the page count and say so downstream —
  // never invent a per-page story.
  const pageNumbers = extraction
    ? extraction.pages.map((p) => p.page)
    : Array.from({ length: pageCount ?? 0 }, (_, i) => i + 1)

  const recorded = new Map(extraction?.pages.map((p) => [p.page, p]) ?? [])

  const pages: InspectedPage[] = pageNumbers.map((n) => {
    const record = recorded.get(n)
    const pageChunks = (byPage.get(n) ?? []).sort((a, b) =>
      a.id.localeCompare(b.id),
    )
    return {
      page: n,
      chunks: pageChunks,
      ...(record?.route ? { route: record.route } : {}),
      ...(record?.outcome ? { outcome: record.outcome } : {}),
      ...(record?.reason ? { reason: record.reason } : {}),
      empty: pageChunks.length === 0,
    }
  })

  const { partial, reasons } = indexingCompleteness(extraction, byPage)
  return { pages, extraction, partial, partialReasons: reasons }
}
