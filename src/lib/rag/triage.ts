/**
 * Deciding which pages are worth an API call (spec 0031 FR1, FR2, NFR1).
 *
 * Pure and free by design. This module is the entire cost story of document
 * cracking: on a rate-limited free tier, the difference between a feature that
 * is affordable and one that is not is whether it fires on every page or only
 * on the pages that need it.
 *
 * ## Why routing is per page, not per document
 *
 * `extract.ts` decides today with `isImageOnly`, which averages characters per
 * page across the WHOLE document. A 40-page text report with a scanned appendix
 * therefore passes the check, ingests, reports success — and the appendix does
 * not exist in the index. Nobody is told. Routing each page on its own evidence
 * is what fixes that, and it happens to be the same mechanism that keeps the
 * cost down.
 *
 * The signals themselves are gathered elsewhere (that part touches `unpdf`);
 * this module only judges them, so the judgement can be unit-tested.
 */

/** What one page looks like, before any decision is taken about it. */
export interface PageSignals {
  /** Characters in the text layer, whitespace trimmed. */
  charCount: number
  /** Positioned text items from `extractTextItems`. */
  itemCount: number
  /** Embedded raster images on the page. */
  imageCount: number
  /**
   * Distinct horizontal bands the text items cluster into. 1 for ordinary
   * prose; 2+ for a multi-column layout the flat extractor may interleave.
   */
  columnCount: number
  /** Share of the page covered by text item boxes, 0..1. */
  textAreaRatio: number
}

/**
 * How a page will be processed.
 *
 * - `clean-text` — the text layer is trustworthy. Free path, no API call.
 * - `structured` — there is text, but its layout will not survive flattening
 *   (columns, or dense small items that read like a table).
 * - `image-heavy` — meaningful text, but images carry content too.
 * - `no-text` — nothing to extract; the page is a picture of a document.
 */
export type PageRoute = 'clean-text' | 'structured' | 'image-heavy' | 'no-text'

export interface TriageOptions {
  /** Below this, the page has no usable text layer at all. */
  minChars?: number
  /** At or above this column count, flattening is unsafe. */
  minColumns?: number
  /** Images beyond this many mean the page is carrying visual content. */
  minImages?: number
  /**
   * Text items per 1% of covered area, above which the page looks tabular:
   * many short items packed into little space is what a table looks like from
   * the outside.
   */
  denseItemRatio?: number
}

export const TRIAGE_DEFAULTS: Required<TriageOptions> = {
  // Matches the spirit of RAG_MIN_CHARS_PER_PAGE, applied per page rather than
  // averaged across the document.
  minChars: 60,
  minColumns: 2,
  minImages: 1,
  denseItemRatio: 8,
}

/**
 * Route one page.
 *
 * Deliberately ordered so the cheap, certain conclusions come first: a page
 * with no text is always `no-text`, whatever else is true of it. The
 * ambiguous cases resolve toward spending a call rather than toward silence,
 * because the failure this replaces was silent.
 */
export function classifyPage(
  signals: PageSignals,
  options: TriageOptions = {},
): PageRoute {
  const { minChars, minColumns, minImages, denseItemRatio } = {
    ...TRIAGE_DEFAULTS,
    ...options,
  }

  if (signals.charCount < minChars) return 'no-text'
  if (signals.columnCount >= minColumns) return 'structured'

  // Many small items in a small area reads as a table even when the column
  // detector saw one block. Guarded against a zero area, which would otherwise
  // make every sparse page look infinitely dense.
  const coveredPercent = signals.textAreaRatio * 100
  const density = coveredPercent > 0 ? signals.itemCount / coveredPercent : 0
  if (density >= denseItemRatio) return 'structured'

  if (signals.imageCount >= minImages) return 'image-heavy'

  return 'clean-text'
}

/** True when this route spends a parse call. The inverse of "free". */
export function requiresCracking(route: PageRoute): boolean {
  return route !== 'clean-text'
}

/**
 * How many pages of a document would spend a call.
 *
 * Used to report cost before it is incurred, and to apply the per-document cap
 * in ingestion (FR11) against a number rather than discovering the budget is
 * gone halfway through.
 */
export function crackablePageCount(routes: PageRoute[]): number {
  return routes.filter(requiresCracking).length
}
