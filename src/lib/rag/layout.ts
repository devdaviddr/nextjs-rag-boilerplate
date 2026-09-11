/**
 * Finding a document's structure in its text layer (spec 0039).
 *
 * ## Why this exists
 *
 * A page that goes to `nemotron-parse` comes back as typed elements — `Title`,
 * `Section-header`, `Caption`, `Table`, `Picture` — and everything downstream
 * is built on those: captions bind to figures, page furniture is dropped,
 * headings attach to the text they own, and each element becomes its own chunk
 * with its own region.
 *
 * A page that triage routes to the text layer got none of that. It was one
 * page-sized chunk whose `heading` was whatever `detectHeading` found on the
 * first line — usually the running header — with the footer indexed as though
 * it were prose. The same document therefore looked structured on the pages
 * that cost an API call and shapeless on the pages that did not, which is a
 * difference in how a page was *read*, presented to the user as a difference in
 * what the page *contains*.
 *
 * This module closes that gap without an API call, by using the two things a
 * PDF's text layer already reports and this pipeline was throwing away:
 * **point size** and **end-of-line**.
 *
 * ## What the signals can and cannot do
 *
 * Measured on `rag-cracking-test`, page 1: body text 10.5pt, section headers
 * 12.5pt, the document title 17pt, and both the running header and footer
 * 7.5pt. Separating those needs arithmetic, not a model.
 *
 * What it CANNOT do is find a table or a figure: neither has any text-layer
 * signature, and guessing would put a `Table` box around a paragraph. That is
 * not the limitation it sounds like — a page with a table or a figure is
 * routed to the parser by triage before this module ever sees it. What arrives
 * here is prose, and prose is exactly what point size describes well.
 *
 * Every rule below fails towards `Text`. An unclassified paragraph is indexed
 * normally; a paragraph wrongly called furniture is **deleted from the index**.
 * The costs are not symmetric, so neither are the thresholds.
 */

import type { ChunkBox } from '@/db/schema'
import type { PositionedItem } from './chunk'
import type { ElementType, ParsedElement } from './parse-types'

/** One visual line, assembled from the items that share it. */
export interface LayoutLine {
  text: string
  bbox: ChunkBox
  /** Point size, or null when the PDF reported none for any of its items. */
  fontSize: number | null
}

export interface LayoutOptions {
  /**
   * How much larger than body text a line must be to be a heading.
   *
   * 1.12 rather than something safer-sounding: the gap measured between body
   * (10.5) and a section header (12.5) is 1.19, and real documents step by as
   * little as 1 point. A missed heading costs the context it would have given
   * the chunks below it; a false one costs a paragraph promoted to a label,
   * which `maxHeadingChars` is what actually guards against.
   */
  headingRatio?: number
  /** Above this multiple of body size, a heading is the document's title. */
  titleRatio?: number
  /**
   * A heading is short. A long line at 13pt is a pull-quote or a document set
   * in large type, and calling it a heading would prefix a paragraph of prose
   * to every chunk beneath it.
   */
  maxHeadingChars?: number
  /**
   * How many lines at each end of a page may be furniture.
   *
   * Position by RANK, not by a fraction of the page. Measured on
   * `rag-cracking-test`, the running footer sits 71% down a page whose content
   * stops early — an absolute bottom margin misses it entirely, while "the
   * last line on the page" finds it on every page of every document.
   */
  edgeLines?: number
  /** Pages a line must repeat on before it is believed to be furniture. */
  minFurnitureRepeats?: number
}

const DEFAULTS = {
  headingRatio: 1.12,
  titleRatio: 1.4,
  maxHeadingChars: 120,
  edgeLines: 2,
  minFurnitureRepeats: 2,
} satisfies Required<LayoutOptions>

/** No running head is a paragraph. Guards against deleting real content. */
const MAX_FURNITURE_CHARS = 200

/**
 * Vertical gap, as a multiple of glyph height, that ends a paragraph.
 *
 * Measured on `rag-cracking-test`: consecutive lines of one paragraph leave
 * ~0.14 of a glyph height between their boxes, while a blank line between
 * paragraphs leaves ~1.3. Anywhere in between separates them; 0.6 sits in the
 * middle of a gap an order of magnitude wide.
 */
const PARAGRAPH_GAP = 0.6

/** A caption names its own figure or table. Nothing else opens this way. */
const CAPTION_PATTERN =
  /^\s*(table|figure|fig\.?|chart|diagram|exhibit|plate)\s*\d/i

function union(a: ChunkBox, b: ChunkBox): ChunkBox {
  return {
    xmin: Math.min(a.xmin, b.xmin),
    ymin: Math.min(a.ymin, b.ymin),
    xmax: Math.max(a.xmax, b.xmax),
    ymax: Math.max(a.ymax, b.ymax),
  }
}

/**
 * Group a page's items into visual lines.
 *
 * `endsLine` is the PDF's own statement that a line ended, so it is trusted
 * first. Vertical position is the fallback for a producer that does not report
 * it — two items on the same baseline are the same line whatever else is true.
 */
export function toLines(items: readonly PositionedItem[]): LayoutLine[] {
  const lines: LayoutLine[] = []
  let text = ''
  let bbox: ChunkBox | null = null
  let weighted = 0
  let chars = 0

  const flush = () => {
    const trimmed = text.trim()
    if (trimmed.length > 0 && bbox) {
      lines.push({
        text: trimmed,
        bbox,
        fontSize: chars > 0 ? weighted / chars : null,
      })
    }
    text = ''
    bbox = null
    weighted = 0
    chars = 0
  }

  let previousTop: number | null = null

  for (const item of items) {
    if (item.box) {
      // A new baseline starts a new line even without an explicit break.
      const height = item.box.ymax - item.box.ymin
      if (
        previousTop !== null &&
        Math.abs(item.box.ymin - previousTop) > height * 0.6
      ) {
        flush()
      }
      previousTop = item.box.ymin
      bbox = bbox ? union(bbox, item.box) : item.box
    }

    text += item.str
    if (item.fontSize && item.str.trim().length > 0) {
      // Weighted by characters so one stray glyph cannot set a line's size.
      weighted += item.fontSize * item.str.trim().length
      chars += item.str.trim().length
    }

    if (item.endsLine) {
      flush()
      previousTop = null
    }
  }
  flush()

  return lines
}

/**
 * The document's body point size.
 *
 * The most *characters*, not the most lines: a page of headings would
 * otherwise redefine what body text is, and every paragraph on it would then
 * look like a footnote.
 *
 * Null when nothing reported a size, which makes every ratio test below
 * impossible — and `classifyLines` then leaves the page as plain text rather
 * than inventing a structure out of position alone.
 */
export function bodyFontSize(
  pages: readonly (readonly LayoutLine[])[],
): number | null {
  const weight = new Map<number, number>()
  for (const lines of pages) {
    for (const line of lines) {
      if (!line.fontSize) continue
      // Rounded to a quarter point: the same font reports 10.4999995 and
      // 10.5 on different lines, and those must not be two sizes.
      const key = Math.round(line.fontSize * 4) / 4
      weight.set(key, (weight.get(key) ?? 0) + line.text.length)
    }
  }
  let best: number | null = null
  let bestWeight = 0
  for (const [size, w] of weight) {
    if (w > bestWeight) {
      best = size
      bestWeight = w
    }
  }
  return best
}

/**
 * A line's identity for repeat-detection, with page numbers masked out.
 *
 * Null for any line that is not a furniture CANDIDATE — too far from either
 * end of the page, too long, or set larger than body text. Those three guards
 * are what stand between this and deleting a real paragraph from the index,
 * which is the only truly expensive mistake this module can make.
 */
function furnitureKey(
  line: LayoutLine,
  index: number,
  lineCount: number,
  options: { edgeLines: number; bodySize: number | null },
): string | null {
  const top = index < options.edgeLines
  const bottom = index >= lineCount - options.edgeLines
  if (!top && !bottom) return null
  if (line.text.length > MAX_FURNITURE_CHARS) return null
  // A running head is set SMALLER than the body — measured at 7.5 against a
  // body of 10.5. Strictly smaller, not "no larger": on a short page the last
  // line of real prose is positionally an edge line, and if a document repeats
  // a sentence ("Signature: ______") it would be deleted from the index. A
  // running head that happens to be set at body size is therefore missed and
  // stays indexed, which is exactly the behaviour this path had before — the
  // costs are not symmetric, so the test is not either.
  if (
    options.bodySize !== null &&
    (line.fontSize === null || line.fontSize >= options.bodySize)
  ) {
    return null
  }
  // "Page 1 of 7" and "Page 6 of 7" are the same running footer. Without this
  // masking a paginated footer repeats zero times and is never recognised.
  const masked = line.text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
  return `${top ? 'top' : 'bottom'}:${masked.toLowerCase()}`
}

/**
 * Lines that repeat in the same margin across pages — the running header and
 * footer (FR2).
 *
 * Repetition is the whole signal, and it is why this is computed across the
 * document rather than per page. A single page cannot distinguish its footer
 * from its last sentence.
 */
export function findFurniture(
  pages: readonly (readonly LayoutLine[])[],
  bodySize: number | null,
  options: LayoutOptions = {},
): Set<string> {
  const { edgeLines, minFurnitureRepeats } = { ...DEFAULTS, ...options }
  const counts = new Map<string, number>()

  for (const lines of pages) {
    // Once per page: a key appearing twice on one page is not a repeat.
    const onThisPage = new Set<string>()
    for (const [index, line] of lines.entries()) {
      const key = furnitureKey(line, index, lines.length, {
        edgeLines,
        bodySize,
      })
      if (key) onThisPage.add(key)
    }
    for (const key of onThisPage) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  const furniture = new Set<string>()
  for (const [key, count] of counts) {
    if (count >= minFurnitureRepeats) furniture.add(key)
  }
  // A one-page document has nothing to repeat against, so nothing is furniture.
  return pages.length >= minFurnitureRepeats ? furniture : new Set()
}

/**
 * Give every line on a page a type.
 *
 * The order of the tests is the order of confidence. Furniture is decided by
 * repetition across pages, which is evidence no single line can contradict.
 * A caption names itself. Size decides the rest.
 */
export function classifyLines(
  lines: readonly LayoutLine[],
  context: {
    bodySize: number | null
    furniture: ReadonlySet<string>
    options?: LayoutOptions
  },
): { line: LayoutLine; type: ElementType }[] {
  const options = { ...DEFAULTS, ...context.options }
  const { bodySize, furniture } = context

  return lines.map((line, index) => {
    const key = furnitureKey(line, index, lines.length, {
      edgeLines: options.edgeLines,
      bodySize,
    })
    if (key && furniture.has(key)) {
      return {
        line,
        type: (key.startsWith('top:')
          ? 'Page-header'
          : 'Page-footer') as ElementType,
      }
    }

    if (CAPTION_PATTERN.test(line.text)) {
      return { line, type: 'Caption' as ElementType }
    }

    if (
      bodySize &&
      line.fontSize &&
      line.text.length <= options.maxHeadingChars
    ) {
      const ratio = line.fontSize / bodySize
      if (ratio >= options.titleRatio) return { line, type: 'Title' }
      if (ratio >= options.headingRatio) {
        return { line, type: 'Section-header' as ElementType }
      }
    }

    return { line, type: 'Text' as ElementType }
  })
}

/**
 * One page of text-layer lines, as the elements the rest of the pipeline reads.
 *
 * The output is deliberately `ParsedElement[]` — the parser's own shape — so
 * `normalizePage` and `chunkElements` handle a text-layer page and a parsed
 * page with the same code. That convergence is the point of the spec: the two
 * paths differ in what they can SEE, and should not differ in anything else.
 *
 * Consecutive body lines are merged into a paragraph. A gap wider than a line
 * ends it, which is what a blank line between paragraphs looks like from here.
 */
export function toElements(
  lines: readonly LayoutLine[],
  context: {
    bodySize: number | null
    furniture: ReadonlySet<string>
    options?: LayoutOptions
  },
): ParsedElement[] {
  const classified = classifyLines(lines, context)
  const out: ParsedElement[] = []

  let open: { type: ElementType; text: string[]; bbox: ChunkBox } | null = null
  let lastBottom = 0
  let lastHeight = 0

  const close = () => {
    if (!open) return
    out.push({ type: open.type, text: open.text.join('\n'), bbox: open.bbox })
    open = null
  }

  for (const { line, type } of classified) {
    const height = line.bbox.ymax - line.bbox.ymin
    const gap = line.bbox.ymin - lastBottom
    // Only prose runs on. A heading, a caption or a piece of furniture is one
    // line's worth of meaning and merging two would invent a third.
    //
    // The NEGATIVE bound is what handles columns. When text moves from the foot
    // of one column to the head of the next, the gap is large and negative —
    // indistinguishable from "no gap" to a test that only looks for a big
    // positive one. Measured on `rag-cracking-test` page 2, that merged the end
    // of the left column into the start of the right: two paragraphs about two
    // different buildings, indexed as one passage.
    const continues =
      open !== null &&
      open.type === 'Text' &&
      type === 'Text' &&
      gap >= -Math.max(height, lastHeight) * 0.3 &&
      gap <= Math.max(height, lastHeight) * PARAGRAPH_GAP

    if (continues && open) {
      open.text.push(line.text)
      open.bbox = union(open.bbox, line.bbox)
    } else {
      close()
      open = { type, text: [line.text], bbox: line.bbox }
    }

    lastBottom = line.bbox.ymax
    lastHeight = height
  }
  close()

  return out
}

/**
 * Everything the per-page pass needs that only the whole document can know.
 *
 * Computed once per ingestion: body size and furniture are both document-level
 * facts, and deriving them per page would make the first page's answer differ
 * from the fifth's.
 */
export interface DocumentLayout {
  bodySize: number | null
  furniture: Set<string>
  options?: LayoutOptions
}

export function documentLayout(
  pageItems: readonly (readonly PositionedItem[])[],
  options: LayoutOptions = {},
): { layout: DocumentLayout; linesByPage: LayoutLine[][] } {
  const linesByPage = pageItems.map((items) => toLines(items))
  const bodySize = bodyFontSize(linesByPage)
  return {
    layout: {
      bodySize,
      furniture: findFurniture(linesByPage, bodySize, options),
      options,
    },
    linesByPage,
  }
}
