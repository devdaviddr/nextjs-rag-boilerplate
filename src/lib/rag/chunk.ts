/**
 * Token-aware, page-bounded chunking.
 *
 * Deliberately dependency-free and pure so it can be unit-tested without a
 * database, a network, or a PDF. Chunks NEVER span a page boundary — that is
 * what lets every citation resolve to an exact page (spec 0025 FR6).
 */

import type { ChunkBox, ChunkKind } from '@/db/schema'
import type { NormalizedElement } from './normalize'

/**
 * One item of a page's text layer, with its box already in OUR convention.
 *
 * The conversion out of PDF space happens once, at extraction
 * (`signals.ts:toPositionedItems`), so nothing downstream has to know that
 * PDF's own coordinate system has its origin at the BOTTOM-left while every
 * box this module emits has it at the top-left (spec 0035 FR2).
 *
 * `box` is nullable and the item is kept anyway. An item whose geometry is
 * degenerate — pdf.js reports `height: 0` for some — still contributes its
 * CHARACTERS, and the character sequence is what maps a chunk back onto the
 * page. Dropping the item entirely would silently shift every offset after it.
 */
export interface PositionedItem {
  str: string
  box: ChunkBox | null
}

export interface PageText {
  /** 1-based, matching what a reader sees in a PDF viewer. */
  pageNumber: number
  text: string
  /**
   * The page's positioned text items, in the order their text appears in
   * `text` (spec 0035 FR1). Optional: without them a chunk simply has no
   * boxes, which is FR4's fallback and not an error.
   */
  items?: readonly PositionedItem[]
}

export interface Chunk {
  content: string
  /** Detected section heading for the page this chunk came from, if any. */
  heading: string | null
  pageNumber: number
  /** Position within the document, stable across the whole page sequence. */
  chunkIndex: number
  tokenCount: number
  /**
   * What this chunk is (spec 0031). `chunkPages` only ever produces 'text';
   * the cracked path produces all four. Optional so the text-layer path is
   * unchanged and existing callers keep compiling.
   */
  kind?: ChunkKind
  /**
   * ONE region of the page, normalised 0–1 top-left — what `chunks.bbox`
   * stores today.
   *
   * Set only when `boxes` collapses to a single region honestly: see
   * `unionIfContiguous`. A chunk laid out down two columns leaves this null
   * rather than storing the union of both, because that union covers the
   * gutter and half of the wrong column — spec 0035 is explicit that no box is
   * better than a wrong box, and a highlight drawn from a wrong box is a
   * confident lie about where the answer came from.
   */
  bbox?: ChunkBox | null
  /**
   * EVERY region of the page this chunk covers, normalised 0–1 top-left
   * (spec 0035 FR6).
   *
   * The list, not the union, is the truthful answer: a two-column chunk is two
   * rectangles. `bbox` above is the lossy projection of this onto the single
   * column the schema has today, and the two are populated from the same walk
   * so they can never disagree.
   */
  boxes?: ChunkBox[]
  /** A caption bound to a table or figure, carried into the embedded text. */
  caption?: string | null
  /**
   * Where the heading and caption sit on the page (spec 0038 FR2).
   *
   * Only the cracked path has them: `chunkPages` derives its heading from the
   * page's first line, which has no box because the text layer has no layout.
   */
  headingBox?: ChunkBox | null
  captionBox?: ChunkBox | null
}

export interface ChunkOptions {
  chunkTokens: number
  overlapTokens: number
}

/**
 * Atoms a byte-pair tokenizer keeps together: a run of letters, a run of
 * digits, or a run of symbols. Whitespace is deliberately not an atom — a
 * leading space is absorbed into the token that follows it.
 */
const TOKEN_ATOMS = /[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]+/g

/** A space immediately before a digit, which does NOT get absorbed. */
const SPACED_DIGITS = /\s[0-9]/g

/**
 * Calibrated against the embedding endpoint's own `usage` counts on
 * 2026-09-11 — 15 samples of prose, table markup and OCR-like text, one
 * `/embeddings` call each, `nvidia/nemotron-3-embed-1b`. Fitted to minimise
 * the WORST relative error rather than the mean, because a chunk that
 * overshoots its budget is the failure that matters.
 */
const CHARS_PER_WORD_TOKEN = 6.6
const CHARS_PER_SYMBOL_TOKEN = 2.5
const SPACED_DIGIT_TOKENS = 0.5
const FRAMING_TOKENS = 2

/**
 * Approximate token count, calibrated against the endpoint's own counts
 * (spec 0033, 1d).
 *
 * Still named "estimate" because it still is one — but it is no longer
 * `length / 4`, which was measured wrong in a way that mattered. Against the
 * provider's reported `usage.prompt_tokens` on 15 samples:
 *
 * |            | `length / 4`        | this          |
 * | ---------- | ------------------- | ------------- |
 * | prose      | mean −9.6%, max 19% | max 9.5%      |
 * | OCR text   | mean −7.5%, max 17% | max 7.3%      |
 * | **tables** | **mean −48%, max −60%** | **max 8.1%** |
 *
 * The table row is the whole reason for this change. Document cracking put
 * LaTeX `tabular` markup and pipe tables into the corpus, and their
 * character-to-token ratio is ~2, not ~4: a "512-token" chunk of table markup
 * was really ~1000 tokens, so every budget, overlap tail and boundary computed
 * over it was out by a factor of two.
 *
 * ## Why this shape rather than a ratio
 *
 * A single characters-per-token ratio cannot be right for both prose and
 * markup, so this counts the things a byte-pair tokenizer actually charges
 * for. Every constant was fitted, and each one corresponds to observed
 * behaviour: a word costs one token per ~6.6 letters, a digit costs a token
 * EACH (which is why a numeric table is so much denser than it looks), a run
 * of symbols costs one per ~2.5 characters, and a space before a digit is not
 * absorbed the way a space before a letter is.
 *
 * ## What this is not
 *
 * It is not the model's vocabulary. Spec 0033 asks for a real tokenizer if
 * calibration cannot get within a few percent, and this gets to ~10% worst
 * case (11% leaving each sample out of its own fit), not to a few. It is a
 * six-fold improvement on what it replaces and it costs no dependency; a
 * vocabulary would need one, at ingestion only, and that is a separate
 * decision with its own supply-chain question.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0

  let tokens = FRAMING_TOKENS
  for (const [atom] of text.matchAll(TOKEN_ATOMS)) {
    if (/^[0-9]/.test(atom)) tokens += atom.length
    else if (/^[A-Za-z]/.test(atom)) {
      tokens += Math.max(1, Math.ceil(atom.length / CHARS_PER_WORD_TOKEN))
    } else {
      tokens += Math.max(1, Math.ceil(atom.length / CHARS_PER_SYMBOL_TOKEN))
    }
  }
  tokens += (text.match(SPACED_DIGITS)?.length ?? 0) * SPACED_DIGIT_TOKENS

  return Math.ceil(tokens)
}

/**
 * Detect a section heading at the top of a page (spec 0027, 1a).
 *
 * Deliberately conservative: a heading is a short first line that is not a
 * sentence — all-caps, or title-case without terminal punctuation. Getting this
 * wrong is cheap in one direction (a missed heading loses a little context) and
 * expensive in the other (a sentence promoted to a heading is prepended to
 * every chunk on the page and pollutes their embeddings), so it prefers to miss.
 */
export function detectHeading(pageText: string): string | null {
  const first = pageText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!first) return null
  if (first.length > 90) return null
  if (/[.!?;:]$/.test(first)) return null

  const letters = first.replace(/[^A-Za-z]/g, '')
  if (letters.length < 3) return null

  const isAllCaps = letters === letters.toUpperCase()
  const words = first.split(/\s+/)
  const isTitleCase =
    words.length <= 12 &&
    words.filter((w) => /^[A-Z]/.test(w)).length >= Math.ceil(words.length / 2)

  return isAllCaps || isTitleCase ? first : null
}

/**
 * The text that gets EMBEDDED for a chunk — not the text that gets displayed.
 *
 * Prefixing the document title and section heading gives the vector something
 * to match when a question names a document or a section. Measured on the
 * evaluation corpus before this existed, `summarise <title>` scored 0.172
 * partly because the title appeared in no chunk's embedded text at all.
 *
 * The original `content` is stored separately and is what the user sees, so a
 * citation never shows this synthetic preamble.
 */
export function buildEmbeddingText(input: {
  documentTitle: string
  heading: string | null
  content: string
  /**
   * A bound caption (spec 0031). Included because a caption is often the only
   * text that says what a table or figure is ABOUT — "Table 3.1 — Utilisation
   * and downtime by site" is what a question matches, while the markup
   * underneath is mostly numbers.
   */
  caption?: string | null
}): string {
  const parts = [input.documentTitle.replace(/[-_]+/g, ' ')]
  if (input.heading) parts.push(input.heading)
  if (input.caption) parts.push(input.caption)
  return `${parts.join(' — ')}\n${input.content}`
}

/**
 * The longest prefix of `text` that fits the budget.
 *
 * Sizing the slice in CHARACTERS is what the previous `budgetTokens * 4` did,
 * and it is exactly where a fixed ratio breaks: table markup runs at ~2
 * characters per token where prose runs at ~3.5, so one constant is wrong for
 * one of them by a factor of two — and the hard-slice path exists precisely
 * for the oversized runs (tables, OCR) where that error is worst. So the first
 * guess comes from the text's OWN measured density, and is then walked down
 * until it actually fits. Always returns at least one character, so every
 * caller terminates.
 */
function sliceToBudget(text: string, budgetTokens: number): string {
  const density = text.length / Math.max(1, estimateTokens(text))
  let take = Math.min(
    text.length,
    Math.max(1, Math.floor(budgetTokens * density)),
  )
  while (take > 1 && estimateTokens(text.slice(0, take)) > budgetTokens) {
    take = Math.floor(take * 0.9)
  }
  return text.slice(0, take)
}

/** Split into paragraphs, then sentences, then hard slices — in that order. */
function splitToBudget(text: string, budgetTokens: number): string[] {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const out: string[] = []
  for (const paragraph of paragraphs) {
    if (estimateTokens(paragraph) <= budgetTokens) {
      out.push(paragraph)
      continue
    }
    // Too big for one chunk on its own — fall back to sentence boundaries.
    const sentences = paragraph.split(/(?<=[.!?])\s+/)
    for (const sentence of sentences) {
      if (estimateTokens(sentence) <= budgetTokens) {
        if (sentence.trim().length > 0) out.push(sentence.trim())
        continue
      }
      // A single "sentence" longer than the budget (tables, OCR runs, minified
      // text). Hard-slice it so the chunker always terminates.
      let rest = sentence
      while (rest.length > 0) {
        const slice = sliceToBudget(rest, budgetTokens)
        const piece = slice.trim()
        if (piece.length > 0) out.push(piece)
        rest = rest.slice(slice.length)
      }
    }
  }
  return out
}

/** Take whole trailing pieces worth up to `overlapTokens`, preserving order. */
function overlapTail(pieces: string[], overlapTokens: number): string[] {
  if (overlapTokens <= 0) return []
  const tail: string[] = []
  let budget = overlapTokens
  for (let i = pieces.length - 1; i >= 0; i--) {
    const piece = pieces[i]
    if (piece === undefined) continue
    const cost = estimateTokens(piece)
    if (cost > budget) break
    tail.unshift(piece)
    budget -= cost
  }
  return tail
}

/**
 * Mapping a chunk's characters back onto the page's text items (spec 0035 FR1).
 *
 * `chunkPages` splits by paragraph and sentence, not by item, so nothing about
 * a chunk says which items it consumed. What IS true is that a chunk's content
 * is a contiguous run of the page's text with only whitespace changed — every
 * split point is a whitespace boundary and the only mutation is `trim()`. So
 * strip whitespace from both sides and the chunk is a plain substring of the
 * page, and a substring search hands back the items that produced it.
 *
 * Stripping whitespace is also what makes this robust to the two sides
 * disagreeing about it: `extractText` joins items with a newline only where
 * pdf.js flagged one, and any future change to that joining is invisible here.
 */
interface ItemLocator {
  /** Every non-whitespace character of the page, in item order. */
  dense: string
  /** `dense[i]` came from `items[owner[i]]`. Non-decreasing by construction. */
  owner: Int32Array
}

function buildLocator(items: readonly PositionedItem[]): ItemLocator {
  const chars: string[] = []
  const owner: number[] = []
  for (let index = 0; index < items.length; index++) {
    const str = items[index]?.str ?? ''
    // Indexed rather than `for..of`, which iterates code POINTS: a surrogate
    // pair would then push one owner entry for two characters and every offset
    // after it would be wrong by one.
    for (let k = 0; k < str.length; k++) {
      const char = str[k] as string
      if (/\s/.test(char)) continue
      chars.push(char)
      owner.push(index)
    }
  }
  return { dense: chars.join(''), owner: Int32Array.from(owner) }
}

/** Boxes of the items covering `dense[start, end)`, in reading order. */
function itemBoxesIn(
  items: readonly PositionedItem[],
  locator: ItemLocator,
  start: number,
  end: number,
): ChunkBox[] {
  const boxes: ChunkBox[] = []
  let previous = -1
  for (let i = start; i < end; i++) {
    const index = locator.owner[i]
    if (index === undefined || index === previous) continue
    previous = index
    const box = items[index]?.box
    if (box) boxes.push(box)
  }
  return boxes
}

function unionBox(a: ChunkBox, b: ChunkBox): ChunkBox {
  return {
    xmin: Math.min(a.xmin, b.xmin),
    ymin: Math.min(a.ymin, b.ymin),
    xmax: Math.max(a.xmax, b.xmax),
    ymax: Math.max(a.ymax, b.ymax),
  }
}

function boxArea(box: ChunkBox): number {
  return Math.max(0, box.xmax - box.xmin) * Math.max(0, box.ymax - box.ymin)
}

/** Overlap along one axis as a share of the SHORTER span, 0–1. */
function overlapRatio(
  aMin: number,
  aMax: number,
  bMin: number,
  bMax: number,
): number {
  const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin)
  if (overlap <= 0) return 0
  const shorter = Math.min(aMax - aMin, bMax - bMin)
  return shorter <= 0 ? 0 : overlap / shorter
}

/** How close two boxes have to be, vertically or horizontally, to be one run. */
const LINE_OVERLAP = 0.5
const BLOCK_OVERLAP = 0.5
/** A gap wider than this many line-heights ends the run. */
const INLINE_GAP_LINES = 1.5
const BLOCK_GAP_LINES = 1.5
/** Beyond this many regions, collapse to one box per column. */
const MAX_REGIONS = 16

/**
 * Item boxes to the handful of regions a highlighter should draw.
 *
 * Two merges, and the first one is the one that is easy to get wrong.
 *
 * **Lines.** Items that share a vertical band are the same line — but ONLY if
 * they are also horizontally adjacent. On a two-column page pdf.js emits the
 * text layer across the gutter: measured on `eval/corpus`, a page reads
 * `"The north wing lift was upgraded in The south wing lift remains on the"`,
 * one visual line of the left column followed immediately by one of the right.
 * Merging on vertical overlap alone would fuse those into a single box
 * spanning both columns and the gutter between them, which is precisely the
 * union FR6 exists to prevent.
 *
 * **Blocks.** Lines join a block when they overlap it horizontally and sit
 * next to it vertically. This searches ALL open blocks rather than only the
 * last, for the same interleaving reason: the lines of a two-column page
 * arrive left, right, left, right, and matching only the previous line would
 * emit two regions per visual row instead of one per column.
 */
function mergeToRegions(boxes: readonly ChunkBox[]): ChunkBox[] {
  const lines: ChunkBox[] = []
  for (const box of boxes) {
    const line = lines.at(-1)
    const height = Math.max(box.ymax - box.ymin, 1e-6)
    const sameBand =
      line !== undefined &&
      overlapRatio(line.ymin, line.ymax, box.ymin, box.ymax) >= LINE_OVERLAP
    const adjacent =
      line !== undefined &&
      Math.max(box.xmin - line.xmax, line.xmin - box.xmax) <=
        height * INLINE_GAP_LINES
    if (line !== undefined && sameBand && adjacent) {
      lines[lines.length - 1] = unionBox(line, box)
    } else {
      lines.push(box)
    }
  }

  const blocks: ChunkBox[] = []
  for (const line of lines) {
    const height = Math.max(line.ymax - line.ymin, 1e-6)
    const target = blocks.findIndex(
      (block) =>
        overlapRatio(block.xmin, block.xmax, line.xmin, line.xmax) >=
          BLOCK_OVERLAP &&
        Math.max(line.ymin - block.ymax, block.ymin - line.ymax) <=
          height * BLOCK_GAP_LINES,
    )
    if (target >= 0) blocks[target] = unionBox(blocks[target] as ChunkBox, line)
    else blocks.push(line)
  }

  if (blocks.length <= MAX_REGIONS) return blocks

  // A chunk of ragged material (a table's cells, an OCR run) can produce a
  // region per line. Collapsing to one box per COLUMN keeps the payload small
  // without ever unioning across a gutter, which is the only union that lies.
  return columnClusters(blocks).map((cluster) =>
    cluster.reduce((a, b) => unionBox(a, b)),
  )
}

/** Group boxes that overlap horizontally, transitively — one group per column. */
function columnClusters(boxes: readonly ChunkBox[]): ChunkBox[][] {
  const clusters: ChunkBox[][] = []
  for (const box of boxes) {
    const hits = clusters.filter((cluster) =>
      cluster.some(
        (other) =>
          Math.min(other.xmax, box.xmax) - Math.max(other.xmin, box.xmin) > 0,
      ),
    )
    if (hits.length === 0) {
      clusters.push([box])
      continue
    }
    // Overlapping several clusters means this box bridges them: merge.
    const merged = hits.flat()
    merged.push(box)
    for (const hit of hits) clusters.splice(clusters.indexOf(hit), 1)
    clusters.push(merged)
  }
  return clusters
}

/** How much of a region list's bounding box the regions themselves cover. */
const MIN_UNION_FILL = 0.65

/**
 * The single box for `chunks.bbox`, or null when one box would lie.
 *
 * The schema stores one rectangle; a chunk can legitimately need several, and
 * the union of several is only honest under both of these:
 *
 * 1. **One column.** Regions in two columns must never be unioned however
 *    tightly they pack, because the union always contains the gutter and the
 *    part of the other column that lies beside them. Measured on
 *    `eval/corpus`: two side-by-side regions of equal height fill 72% of their
 *    union, so an area test alone lets exactly the wrong case through.
 * 2. **Nearly filled.** A column of stacked paragraphs fills its union (the
 *    only thing inside is the leading between them); a full-width heading plus
 *    one column of a two-column page does not, and its union reaches across
 *    into the other column.
 *
 * Otherwise this returns null and the citation falls back to page-level
 * behaviour (FR4). Spec 0035 is explicit that a highlight is a stronger claim
 * than a page number and that no box beats a wrong box. `boxes` still carries
 * the whole truth for a consumer that can draw more than one rectangle.
 */
function unionIfContiguous(regions: readonly ChunkBox[]): ChunkBox | null {
  if (regions.length === 0) return null
  if (columnClusters(regions).length > 1) return null
  const union = regions.reduce((a, b) => unionBox(a, b))
  const area = boxArea(union)
  if (area <= 0) return null
  const covered = regions.reduce((sum, box) => sum + boxArea(box), 0)
  return covered / area >= MIN_UNION_FILL ? union : null
}

/**
 * Chunk a document's pages.
 *
 * Overlap is carried within a page only. Carrying it across a page boundary
 * would put text from page N into a chunk cited as page N+1, which is exactly
 * the kind of quiet citation error that makes a RAG answer untrustworthy.
 */
export function chunkPages(pages: PageText[], options: ChunkOptions): Chunk[] {
  const { chunkTokens, overlapTokens } = options
  if (chunkTokens <= 0) throw new Error('chunkTokens must be positive')
  if (overlapTokens >= chunkTokens) {
    throw new Error('overlapTokens must be smaller than chunkTokens')
  }

  const chunks: Chunk[] = []
  let chunkIndex = 0

  for (const page of pages) {
    const pieces = splitToBudget(page.text, chunkTokens)
    if (pieces.length === 0) continue
    const heading = detectHeading(page.text)

    const items = page.items ?? []
    const locator = items.length > 0 ? buildLocator(items) : null
    // Chunks come out in page order, but consecutive ones OVERLAP, so the next
    // search starts where the last chunk started rather than where it ended.
    let searchFrom = 0

    const emit = (content: string) => {
      const chunk: Chunk = {
        content,
        heading,
        pageNumber: page.pageNumber,
        chunkIndex: chunkIndex++,
        tokenCount: estimateTokens(content),
      }

      if (locator) {
        const needle = content.replace(/\s+/g, '')
        // A miss is not an error: the page's text can legitimately come from
        // somewhere other than these items (the cracked path's fallback hands
        // `chunkPages` a page string alone), and then this chunk simply has no
        // boxes — FR4's fallback, which is silent and correct by design.
        const at =
          needle.length > 0 ? findFrom(locator.dense, needle, searchFrom) : -1
        if (at >= 0) {
          searchFrom = at
          const regions = mergeToRegions(
            itemBoxesIn(items, locator, at, at + needle.length),
          )
          if (regions.length > 0) {
            chunk.boxes = regions
            chunk.bbox = unionIfContiguous(regions)
          }
        }
      }

      chunks.push(chunk)
    }

    let current: string[] = []
    let currentTokens = 0

    const flush = () => {
      if (current.length === 0) return
      emit(current.join('\n\n'))
      // Seed the next chunk with the tail of this one so a fact split across
      // the boundary is still retrievable from at least one chunk.
      const tail = overlapTail(current, overlapTokens)
      current = [...tail]
      currentTokens = tail.reduce((sum, p) => sum + estimateTokens(p), 0)
    }

    for (const piece of pieces) {
      const cost = estimateTokens(piece)
      if (current.length > 0 && currentTokens + cost > chunkTokens) {
        flush()
        // The overlap tail could itself leave no room; drop it if so.
        if (currentTokens + cost > chunkTokens) {
          current = []
          currentTokens = 0
        }
      }
      current.push(piece)
      currentTokens += cost
    }

    // Final flush for the page — without re-seeding overlap.
    if (current.length > 0) emit(current.join('\n\n'))
  }

  return chunks
}

/** `indexOf` from a cursor, retried from the top before giving up. */
function findFrom(haystack: string, needle: string, from: number): number {
  const at = haystack.indexOf(needle, from)
  return at >= 0 ? at : haystack.indexOf(needle)
}

/**
 * Chunk one CRACKED page's normalised elements (spec 0031 Stage 5).
 *
 * The sibling of `chunkPages`, for pages that went through the parser instead
 * of the text layer. Three rules differ, and each has a reason:
 *
 * 1. **An atomic element is one chunk, never split.** Half a table is not a
 *    smaller table, it is a set of numbers whose header is in another chunk —
 *    strictly worse than the flattened text this replaces. Oversized tables
 *    are therefore allowed to exceed `chunkTokens`; the model's context is far
 *    larger than any one table, and a split one is wrong rather than merely
 *    large.
 * 2. **Each element carries its OWN heading**, resolved upstream, rather than
 *    the page's first line.
 * 3. **A figure's content is a search key, not evidence.** It is written to
 *    make the figure findable; `kind: 'figure'` is what tells retrieval and
 *    citation not to treat it as the document's words.
 *
 * `startIndex` continues the document-wide `chunkIndex` sequence, because a
 * document mixes cracked and text-layer pages and the ordering has to stay
 * monotonic across both.
 */
export function chunkElements(
  elements: readonly NormalizedElement[],
  pageNumber: number,
  options: ChunkOptions & { startIndex?: number; textKind?: ChunkKind },
): Chunk[] {
  const {
    chunkTokens,
    overlapTokens,
    startIndex = 0,
    textKind = 'text',
  } = options
  if (chunkTokens <= 0) throw new Error('chunkTokens must be positive')

  const chunks: Chunk[] = []
  let chunkIndex = startIndex

  const push = (
    content: string,
    kind: ChunkKind,
    element: NormalizedElement,
  ) => {
    if (content.trim().length === 0) return
    chunks.push({
      content,
      heading: element.heading,
      caption: element.caption,
      headingBox: element.headingBox,
      captionBox: element.captionBox,
      pageNumber,
      chunkIndex: chunkIndex++,
      tokenCount: estimateTokens(content),
      kind,
      bbox: element.bbox,
      // One element is one region, so the list and the single box agree
      // trivially here. Populated anyway so a consumer reads `boxes` for both
      // paths and never has to ask which one produced a chunk (FR2).
      boxes: [element.bbox],
    })
  }

  for (const element of elements) {
    if (element.type === 'Table') {
      push(element.text, 'table', element)
      continue
    }
    if (element.type === 'Picture') {
      push(element.text, 'figure', element)
      continue
    }

    // Ordinary prose. Split to the same budget the text-layer path uses, but
    // per element rather than per page, so a split can never merge two
    // elements that the layout kept apart.
    const pieces = splitToBudget(element.text, chunkTokens)
    let current: string[] = []
    let currentTokens = 0

    const flush = () => {
      if (current.length === 0) return
      push(current.join('\n\n'), textKind, element)
      const tail = overlapTail(current, overlapTokens)
      current = [...tail]
      currentTokens = tail.reduce((sum, p) => sum + estimateTokens(p), 0)
    }

    for (const piece of pieces) {
      const cost = estimateTokens(piece)
      if (current.length > 0 && currentTokens + cost > chunkTokens) {
        flush()
        if (currentTokens + cost > chunkTokens) {
          current = []
          currentTokens = 0
        }
      }
      current.push(piece)
      currentTokens += cost
    }
    if (current.length > 0) push(current.join('\n\n'), textKind, element)
  }

  return chunks
}
