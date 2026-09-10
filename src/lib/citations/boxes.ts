/**
 * Turning a stored `chunks.bbox` into rectangles a viewer may actually draw
 * (spec 0035 FR3, FR4, FR6).
 *
 * Pure and dependency-free on purpose: this is the one place that decides
 * whether a highlight is drawn at all, and that decision has to be testable
 * without a database, a PDF or a browser.
 *
 * ## Why this is defensive to the point of paranoia
 *
 * Spec 0035: "A highlight is a stronger claim than a page number." Pointing at
 * a page says the answer is around here; drawing a box says *this text,
 * exactly*. A wrong box is therefore worse than no box — it is a confident
 * lie in a system whose entire value is that its citations can be trusted.
 * So every rule below fails towards **dropping** a rectangle, and dropping
 * every rectangle is a supported outcome (FR4): the citation then behaves
 * exactly as it did before this spec, opening at the page with no highlight.
 *
 * The input is `jsonb` written by two different ingestion paths across
 * multiple schema versions, so it is treated as `unknown` rather than trusted
 * to match `ChunkBox`. Three shapes are in the wild and all three are handled:
 * `null` (every document ingested before spec 0031), a single object (the
 * cracked path as spec 0031 shipped it), and an array (a chunk spanning
 * several elements, spec 0035 FR6).
 */

import type { ChunkKind } from '@/db/schema'

/** One rectangle on a page, normalised 0–1 with the origin at the top-left. */
export interface CitationBox {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

/**
 * What the citation panel needs to draw a highlight, as
 * `/api/citations/[chunkId]` returns it.
 *
 * Declared here rather than beside the route so a client component can import
 * the type without importing a module that reaches for the database — the
 * `server-only` guard on `src/db` exists precisely to make that mistake loud,
 * and a type-only import is not worth teaching people to work around it.
 */
export interface CitationLocation {
  documentId: string
  pageNumber: number
  /** From `documents.page_count`; null for a document ingested without one. */
  pageCount: number | null
  /**
   * What the cited chunk IS (spec 0031 FR8). The panel needs this because a
   * `figure` chunk's content is a search key, not the document's words — a
   * highlight around it must be labelled as marking a described figure, not
   * presented as a quotation (spec 0035 FR5).
   */
  kind: ChunkKind
  /** Possibly empty — see `toCitationBoxes`. Empty means "no highlight". */
  boxes: CitationBox[]
}

/**
 * How far outside the page an edge may sit before the box is disbelieved.
 *
 * `normalize.ts` allows the same slack at ingestion for the same reason: the
 * parser occasionally puts an edge a hair past 0 or 1, which is a rounding
 * artefact rather than a bad box. Anything further out is not rounding, and a
 * rectangle that genuinely extends off the page is not something a reader
 * should be shown as "the cited passage".
 */
const EDGE_TOLERANCE = 0.02

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * A box is drawable when it is the right way round and on the page.
 *
 * A zero-area box is rejected too — it cites a point, and a rectangle with no
 * area either renders as nothing (an invisible claim) or, once a minimum size
 * is applied, as a box the document never described.
 */
function toBox(raw: unknown): CitationBox | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { xmin, ymin, xmax, ymax } = raw as Record<string, unknown>
  if (![xmin, ymin, xmax, ymax].every(isFiniteNumber)) return null

  const box = {
    xmin: xmin as number,
    ymin: ymin as number,
    xmax: xmax as number,
    ymax: ymax as number,
  }
  if (box.xmin >= box.xmax || box.ymin >= box.ymax) return null
  if (box.xmin < -EDGE_TOLERANCE || box.ymin < -EDGE_TOLERANCE) return null
  if (box.xmax > 1 + EDGE_TOLERANCE || box.ymax > 1 + EDGE_TOLERANCE) {
    return null
  }

  // Clamped only after the box has been believed. Clamping first would repair
  // a wildly out-of-page rectangle into a plausible-looking one instead of
  // rejecting it.
  return {
    xmin: clamp01(box.xmin),
    ymin: clamp01(box.ymin),
    xmax: clamp01(box.xmax),
    ymax: clamp01(box.ymax),
  }
}

function boxKey(box: CitationBox): string {
  return `${box.xmin}:${box.ymin}:${box.xmax}:${box.ymax}`
}

/**
 * Every rectangle worth drawing for a chunk, in the order they were stored.
 *
 * Returns `[]` — never throws, never guesses — for a chunk with no box, a box
 * of an unrecognised shape, or a box that fails the checks above. `[]` is what
 * FR4's page-level fallback is built on, so it must stay a normal outcome
 * rather than an error state.
 *
 * The boxes are deliberately NOT merged into their union. Spec 0035 FR6: on a
 * two-column page a union covers the gutter and the wrong column, which is the
 * exact failure mode this whole module exists to prevent.
 *
 * Exact duplicates are collapsed. `normalize.ts` records that the parser
 * emitted the same element three times on one page; drawn as translucent
 * overlays, duplicates stack into a darker rectangle, which a reader reasonably
 * reads as "more strongly cited" — a meaning nothing in the data supports.
 */
/**
 * Reconcile the two stored shapes into one list (spec 0035 FR6).
 *
 * `boxes` is authoritative when it holds anything usable. `bbox` is the older
 * single rectangle and is used only when `boxes` is absent — rows written
 * before that column existed, which must keep rendering (FR4).
 *
 * A populated `boxes` whose entries ALL fail validation returns empty rather
 * than falling back: that row did record where it came from and the record was
 * unusable, so substituting the older, coarser claim would invent a highlight
 * the chunk never supported. No highlight is strictly better than a wrong one.
 */
export function toCitationBoxes(
  raw: unknown,
  legacyBbox?: unknown,
): CitationBox[] {
  const fromList = Array.isArray(raw) && raw.length > 0
  const source = fromList ? raw : (legacyBbox ?? raw)
  const list = Array.isArray(source) ? source : [source]
  const seen = new Set<string>()
  const boxes: CitationBox[] = []

  for (const item of list) {
    const box = toBox(item)
    if (!box) continue
    const key = boxKey(box)
    if (seen.has(key)) continue
    seen.add(key)
    boxes.push(box)
  }

  return boxes
}

/** CSS percentages for absolutely positioning a box over a rendered page. */
export function boxPercentStyle(box: CitationBox): {
  left: string
  top: string
  width: string
  height: string
} {
  return {
    left: `${box.xmin * 100}%`,
    top: `${box.ymin * 100}%`,
    width: `${(box.xmax - box.xmin) * 100}%`,
    height: `${(box.ymax - box.ymin) * 100}%`,
  }
}
