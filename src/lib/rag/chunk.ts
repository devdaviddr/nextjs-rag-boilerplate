/**
 * Token-aware, page-bounded chunking.
 *
 * Deliberately dependency-free and pure so it can be unit-tested without a
 * database, a network, or a PDF. Chunks NEVER span a page boundary — that is
 * what lets every citation resolve to an exact page (spec 0025 FR6).
 */

import type { ChunkBox, ChunkKind } from '@/db/schema'
import type { NormalizedElement } from './normalize'

export interface PageText {
  /** 1-based, matching what a reader sees in a PDF viewer. */
  pageNumber: number
  text: string
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
  /** Region of the page this came from, normalised 0–1. Cracked path only. */
  bbox?: ChunkBox | null
  /** A caption bound to a table or figure, carried into the embedded text. */
  caption?: string | null
}

export interface ChunkOptions {
  chunkTokens: number
  overlapTokens: number
}

/**
 * Approximate token count at ~4 characters per token.
 *
 * Named "estimate" because it IS one: shipping a real tokenizer would add a
 * multi-megabyte dependency to size a chunk, and the chunker only needs to be
 * roughly right — the model's context is far larger than any single chunk.
 * Deliberately over-estimates slightly rather than under, so a chunk is never
 * unexpectedly larger than the budget.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
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
      const maxChars = budgetTokens * 4
      for (let i = 0; i < sentence.length; i += maxChars) {
        const piece = sentence.slice(i, i + maxChars).trim()
        if (piece.length > 0) out.push(piece)
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

    let current: string[] = []
    let currentTokens = 0

    const flush = () => {
      if (current.length === 0) return
      const content = current.join('\n\n')
      chunks.push({
        content,
        heading,
        pageNumber: page.pageNumber,
        chunkIndex: chunkIndex++,
        tokenCount: estimateTokens(content),
      })
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
    if (current.length > 0) {
      const content = current.join('\n\n')
      chunks.push({
        content,
        heading,
        pageNumber: page.pageNumber,
        chunkIndex: chunkIndex++,
        tokenCount: estimateTokens(content),
      })
    }
  }

  return chunks
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
      pageNumber,
      chunkIndex: chunkIndex++,
      tokenCount: estimateTokens(content),
      kind,
      bbox: element.bbox,
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
