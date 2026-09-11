/**
 * Repairing parser output before it becomes chunks (spec 0031 FR3–FR5).
 *
 * Pure and dependency-free, like `chunk.ts`, so it is testable against recorded
 * responses with no network — see `tests/fixtures/parse/`, which are real
 * `nemotron-parse` outputs with their defects intact.
 *
 * ## Why this module exists
 *
 * The parser is good and it is not trustworthy. Three defects were measured in
 * its output on 2026-09-10, every one of which would corrupt an index silently:
 *
 * 1. **Response order is not reading order.** A `Page-footer` at ymin 0.485 came
 *    back before a `Table` at ymin 0.164. Sorting by array index puts the
 *    document's furniture in the middle of its prose.
 * 2. **Degenerate boxes.** One caption arrived with `xmin 0.031 > xmax 0.022` —
 *    an inverted rectangle, which would crop to nothing at answer time.
 * 3. **Duplicates.** The same caption appeared three times on one page, one copy
 *    carrying the inverted box above.
 *
 * Every function here is deterministic and free. That is the point: the
 * expensive, non-deterministic step already happened upstream, and this is
 * where its output is made safe to build on.
 */

import {
  ATOMIC_TYPES,
  type BBox,
  FURNITURE_TYPES,
  HEADING_TYPES,
  type ParsedElement,
} from './parse-types'

/** An element after repair, carrying the heading that actually owns it. */
export interface NormalizedElement extends ParsedElement {
  /** The nearest preceding heading in reading order, or null (FR5). */
  heading: string | null
  /** A `Caption` bound to this `Table`/`Picture`, if one was found (FR3). */
  caption: string | null
  /**
   * Where the heading and caption sit on the page (spec 0038 FR2).
   *
   * Both are consumed rather than emitted — a heading is never an element of
   * its own and a bound caption is suppressed — so without their boxes nothing
   * downstream can mark them, and text that genuinely was indexed looks on the
   * page like text that was skipped.
   */
  headingBox: BBox | null
  captionBox: BBox | null
  /** Chunk whole, never split to a token budget. */
  atomic: boolean
}

/**
 * A box is usable when it is the right way round and inside the page.
 *
 * Defect 2. A zero-area box is rejected too: it cites a point, which no viewer
 * can highlight and no crop can contain.
 */
export function isUsableBox(bbox: BBox): boolean {
  const { xmin, ymin, xmax, ymax } = bbox
  if (![xmin, ymin, xmax, ymax].every((n) => Number.isFinite(n))) return false
  if (xmin >= xmax || ymin >= ymax) return false
  // A little tolerance either side of the page: the parser occasionally puts an
  // edge a hair outside 0..1, which is a rounding artefact, not a bad box.
  return xmin >= -0.02 && ymin >= -0.02 && xmax <= 1.02 && ymax <= 1.02
}

/** Intersection over union — how much two boxes are the same box. */
export function boxIou(a: BBox, b: BBox): number {
  const ix = Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin)
  const iy = Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin)
  if (ix <= 0 || iy <= 0) return 0
  const intersection = ix * iy
  const areaA = (a.xmax - a.xmin) * (a.ymax - a.ymin)
  const areaB = (b.xmax - b.xmin) * (b.ymax - b.ymin)
  const union = areaA + areaB - intersection
  return union <= 0 ? 0 : intersection / union
}

/** Distance between box centres. The fallback when nothing lines up. */
function centreDistance(a: BBox, b: BBox): number {
  const ax = (a.xmin + a.xmax) / 2
  const ay = (a.ymin + a.ymax) / 2
  const bx = (b.xmin + b.xmax) / 2
  const by = (b.ymin + b.ymax) / 2
  return Math.hypot(ax - bx, ay - by)
}

/** How much two boxes share the same horizontal span, 0..1. */
function horizontalOverlap(a: BBox, b: BBox): number {
  const overlap = Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin)
  if (overlap <= 0) return 0
  const narrower = Math.min(a.xmax - a.xmin, b.xmax - b.xmin)
  return narrower <= 0 ? 0 : overlap / narrower
}

/**
 * Vertical gap between two boxes; 0 when they touch or overlap.
 *
 * This is the signal that actually binds a caption, because a caption sits
 * directly above or below its figure. Centre distance does not capture that:
 * measured on the portrait fixture, "Figure 7.2 — Unplanned downtime trend" is
 * 0.082 from the *table's* centre and 0.103 from the picture's, so a
 * centre-distance rule binds the figure's own caption to the wrong element
 * while sitting flush against the right one.
 */
function verticalGap(a: BBox, b: BBox): number {
  if (a.ymax <= b.ymin) return b.ymin - a.ymax
  if (b.ymax <= a.ymin) return a.ymin - b.ymax
  return 0
}

/** Comparable form for duplicate detection: case, spacing and markup ignored. */
function textKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_#`<>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Close a `tabular` that was cut off mid-markup.
 *
 * **Defensive, not observed.** Every table in the recorded fixtures closes
 * correctly; this guards the case where a very large table meets the parse
 * call's `max_tokens` and the closer is the part that does not fit. Only ever
 * *appends* what is missing — it never rewrites rows, because a table cut
 * mid-row is still better indexed with the rows that survived than discarded.
 */
export function repairTableMarkup(text: string): string {
  const trimmed = text.trimEnd()
  if (!trimmed.includes('\\begin{tabular}')) return trimmed
  if (/\\end\{tabular\}$/.test(trimmed)) return trimmed
  // Drop a partial closer (`\end{`, `\end{tab`, …) before adding the real one.
  const withoutPartial = trimmed.replace(/\\end\{[a-z]*$/i, '').trimEnd()
  return `${withoutPartial}\n\\end{tabular}`
}

/** True when the markup opens a table it never closes, even after repair. */
export function isTruncatedTable(text: string): boolean {
  return text.includes('\\begin{tabular}') && !/\\end\{tabular\}\s*$/.test(text)
}

/**
 * Sort into reading order: columns left to right, rows top to bottom (defect 1).
 *
 * Columns are detected by clustering on box centres rather than left edges —
 * an indented paragraph shares a column with its neighbours but not an `xmin`.
 * With a single column this degrades to a plain top-to-bottom sort, which is
 * what a normal page wants.
 *
 * `columnGap` is the share of page width that must separate two clusters before
 * they count as different columns. 0.15 keeps a two-column A4 spread apart
 * without splitting a wide table into three columns of cells.
 */
export function readingOrder(
  elements: ParsedElement[],
  { columnGap = 0.15 }: { columnGap?: number } = {},
): ParsedElement[] {
  if (elements.length <= 1) return [...elements]

  // A full-width element (a banner, a wide table) belongs to no column and
  // would merge every cluster it touches, so it is ordered purely by y.
  const isFullWidth = (e: ParsedElement) => e.bbox.xmax - e.bbox.xmin > 0.6
  const columnar = elements.filter((e) => !isFullWidth(e))

  const centres = columnar
    .map((e) => (e.bbox.xmin + e.bbox.xmax) / 2)
    .sort((a, b) => a - b)

  // Walk the sorted centres and start a new column wherever the gap is wide.
  const boundaries: number[] = []
  for (let i = 1; i < centres.length; i++) {
    const previous = centres[i - 1] as number
    const current = centres[i] as number
    if (current - previous > columnGap)
      boundaries.push((previous + current) / 2)
  }

  const columnOf = (e: ParsedElement): number => {
    if (isFullWidth(e)) return -1
    const centre = (e.bbox.xmin + e.bbox.xmax) / 2
    return boundaries.filter((b) => centre > b).length
  }

  return [...elements].sort((a, b) => {
    const ca = columnOf(a)
    const cb = columnOf(b)
    // Full-width elements (column -1) sort by y against everything, so a
    // spanning table stays where it sits rather than jumping to the front.
    if (ca !== cb && ca !== -1 && cb !== -1) return ca - cb
    if (Math.abs(a.bbox.ymin - b.bbox.ymin) > 0.005) {
      return a.bbox.ymin - b.bbox.ymin
    }
    return a.bbox.xmin - b.bbox.xmin
  })
}

/**
 * Drop repeats of the same element (defect 3).
 *
 * Two elements are the same when their text matches after normalisation AND
 * their boxes overlap, or when one is a strict text duplicate of the other with
 * an unusable box. Text alone is too eager: a page can legitimately repeat a
 * short line ("continued") in two different places.
 */
export function dedupe(
  elements: ParsedElement[],
  { minIou = 0.3 }: { minIou?: number } = {},
): ParsedElement[] {
  const kept: ParsedElement[] = []
  for (const element of elements) {
    const key = textKey(element.text)
    const duplicate = kept.find((k) => {
      if (textKey(k.text) !== key) return false
      // An unusable box on EITHER copy means IoU is meaningless — an inverted
      // rectangle intersects nothing, so overlap would say "different" about
      // two copies of the same sentence. Matching text is enough in that case.
      if (!isUsableBox(element.bbox) || !isUsableBox(k.bbox)) return true
      return boxIou(k.bbox, element.bbox) >= minIou
    })
    if (!duplicate) {
      kept.push(element)
      continue
    }
    // Prefer the copy with the usable box — the duplicate may be the only one
    // carrying a box we can crop or highlight later.
    if (!isUsableBox(duplicate.bbox) && isUsableBox(element.bbox)) {
      kept[kept.indexOf(duplicate)] = element
    }
  }
  return kept
}

/**
 * Bind each caption to the table or picture it describes (FR3).
 *
 * Nearest atomic element by centre distance, within `maxDistance`. A caption
 * that binds to nothing stays in the flow as ordinary text — losing it would
 * lose a sentence the document actually contains.
 */
function bindCaptions(
  elements: ParsedElement[],
  maxDistance: number,
): Map<number, { text: string; bbox: BBox }> {
  const bindings = new Map<number, { text: string; bbox: BBox }>()
  const atomics = elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => ATOMIC_TYPES.has(element.type))

  elements.forEach((element) => {
    if (element.type !== 'Caption' || atomics.length === 0) return

    let best: { index: number; score: number; adjacent: boolean } | null = null
    for (const { index, element: atomic } of atomics) {
      // Sitting flush above or below, in the same horizontal span, beats being
      // near in a straight line. Only fall back to centre distance when nothing
      // lines up at all.
      const adjacent = horizontalOverlap(element.bbox, atomic.bbox) >= 0.5
      const score = adjacent
        ? verticalGap(element.bbox, atomic.bbox)
        : centreDistance(element.bbox, atomic.bbox)
      if (
        !best ||
        (adjacent && !best.adjacent) ||
        (adjacent === best.adjacent && score < best.score)
      ) {
        best = { index, score, adjacent }
      }
    }

    if (!best || best.score > maxDistance) return
    // First caption wins: after dedupe, a second one binding to the same figure
    // is a different caption, and overwriting would silently discard it.
    if (!bindings.has(best.index)) {
      bindings.set(best.index, {
        text: element.text.trim(),
        bbox: element.bbox,
      })
    }
  })

  return bindings
}

export interface NormalizeOptions {
  /** Max centre-to-centre distance for a caption to bind. Page-relative. */
  captionMaxDistance?: number
  /** Share of page width separating two columns. */
  columnGap?: number
}

/**
 * Turn one page of raw parser output into elements safe to chunk.
 *
 * Order matters and is not arbitrary:
 *
 *   drop unusable boxes → dedupe → reading order → bind captions →
 *   drop furniture → attach headings
 *
 * Dedupe runs before ordering so a duplicate cannot displace its original in
 * the sort. Furniture is dropped *after* captions bind, because a caption's
 * nearest neighbour may be a footer it must not bind to — and *before*
 * headings attach, so a running header never becomes a section heading.
 */
export function normalizePage(
  elements: ParsedElement[],
  options: NormalizeOptions = {},
): NormalizedElement[] {
  const { captionMaxDistance = 0.25, columnGap = 0.15 } = options

  const usable = elements.filter(
    (element) => isUsableBox(element.bbox) && element.text.trim().length > 0,
  )
  const deduped = dedupe(usable)
  const ordered = readingOrder(deduped, { columnGap })
  const captions = bindCaptions(ordered, captionMaxDistance)

  // Which captions got bound, so they are not also emitted as loose text.
  const boundCaptionText = new Set(
    [...captions.values()].map(({ text }) => textKey(text)),
  )

  const out: NormalizedElement[] = []
  let heading: string | null = null
  let headingBox: BBox | null = null

  ordered.forEach((element, index) => {
    if (FURNITURE_TYPES.has(element.type)) return

    if (HEADING_TYPES.has(element.type)) {
      // Strip leading markdown hashes the parser emits on headings.
      heading = element.text.replace(/^#+\s*/, '').trim() || null
      // Cleared with the heading: a box with no text to explain it is a
      // rectangle drawn around nothing.
      headingBox = heading ? element.bbox : null
      return
    }

    if (
      element.type === 'Caption' &&
      boundCaptionText.has(textKey(element.text))
    ) {
      return
    }

    const atomic = ATOMIC_TYPES.has(element.type)
    const text =
      element.type === 'Table' ? repairTableMarkup(element.text) : element.text
    const caption = captions.get(index) ?? null

    out.push({
      ...element,
      text,
      heading,
      headingBox,
      caption: caption?.text ?? null,
      captionBox: caption?.bbox ?? null,
      atomic,
    })
  })

  return out
}
