import type { ChunkKind } from '@/db/schema'
import { type CitationBox, toCitationBoxes } from '@/lib/citations/boxes'
import type { RetrievedChunk } from './retrieve'

/**
 * Parent–child assembly (spec 0033, 1c).
 *
 * ## What a parent is
 *
 * Children are the chunks ingestion already writes, unchanged: same
 * boundaries, same embedded text, same vectors. A PARENT is the contiguous run
 * of non-figure chunks on one page that share a section key — the heading
 * they were indexed under, plus where that heading sits on the page. Nothing
 * embeds a parent and nothing stores one. It is assembled at query time, after
 * the similarity gate, and only when at least two chunks of the run were
 * admitted by the gate on their own cosine.
 *
 * ## Why it is assembled rather than embedded
 *
 * The spec's first design embedded both. A section-sized vector is a new
 * similarity distribution, and `RAG_MIN_SIMILARITY` (0.35) was calibrated
 * against chunk-sized ones — refusal accuracy, the strongest guarantee in this
 * system, rests on that floor (NFR2). Assembling from children that already
 * cleared it means the gate still decides everything: a parent can only
 * surface where two of its own children would have surfaced anyway. The
 * trade is stated, not hidden: a section where no two children pass on their
 * own can never surface as a parent.
 *
 * ## Why this module is pure
 *
 * The section key is implicit — derived from `heading` and `heading_bbox`,
 * not a persisted column — so if heading semantics change, grouping changes
 * silently. The guard against that is that EVERY consumer (retrieval, the
 * citation route, the inspector) groups through `sectionRuns` below, and that
 * `sectionRuns` is pinned by unit tests with no database in the way. Do not
 * re-derive runs anywhere else.
 */

/** The fields a chunk row needs for grouping into section runs. */
export interface SectionRow {
  id: string
  kind: ChunkKind
  heading: string | null
  /**
   * Where the heading sits on the page. `jsonb`, so it arrives as whatever
   * the driver parsed — typed `unknown` and only ever serialised, never
   * trusted to be a well-formed box.
   */
  headingBbox?: unknown
  chunkIndex: number
}

/** One row of a page, as the parent loader reads it. */
export interface PageRow extends SectionRow {
  documentId: string
  pageNumber: number
  content: string
  tokenCount: number
}

/** Stable text for a jsonb value: keys sorted, so column order cannot matter. */
function stableJson(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

/**
 * What makes two chunks "the same section".
 *
 * The heading string alone would merge two different sections that share a
 * title on one page ("Notes", "Scope"). The heading's box separates them and
 * costs nothing — it is already stored (spec 0038 FR2). Rows with no box key
 * on the string alone, and what that means depends on where the heading came
 * from:
 *
 * - the `chunkPages` fallback (and every text-layer row ingested before 0039)
 *   has one heading per page, its first line, so the run is the page;
 * - a cracked row ingested before 0038 has its element's real heading but no
 *   box, so the run is still the section, except that two adjacent sections
 *   sharing a title on one page merge.
 *
 * Cracked rows ingested since 0038 carry the box and group exactly. Every
 * case is still single-page and still gated.
 */
export function sectionKey(row: {
  heading?: string | null
  headingBbox?: unknown
}): string {
  return `${row.heading ?? ''}\u0000${stableJson(row.headingBbox)}`
}

/**
 * Split ONE page's rows into section runs, in reading order.
 *
 * - Rows are ordered by `chunkIndex`; a new run opens whenever the key changes.
 * - A `figure` row is skipped and does NOT break the run around it. Its
 *   content is a search key written to make the figure findable, not the
 *   document's words (spec 0031 FR8), so it is never evidence inside a parent
 *   — and a figure placed between two paragraphs of one section is still one
 *   section either side of it.
 * - Tables and OCR rows are members like any other text.
 * - Rows before the first heading (key `''`) form their own run.
 *
 * The caller passes one page. Runs never span a page because they are
 * computed per page, which is what keeps every parent citation exact (NFR3,
 * spec 0025 FR6).
 */
export function sectionRuns<T extends SectionRow>(
  pageRows: readonly T[],
): T[][] {
  const ordered = [...pageRows].sort((a, b) => a.chunkIndex - b.chunkIndex)
  const runs: T[][] = []
  let current: T[] = []
  let currentKey: string | null = null

  for (const row of ordered) {
    if (row.kind === 'figure') continue
    const key = sectionKey(row)
    if (currentKey !== null && key !== currentKey) {
      runs.push(current)
      current = []
    }
    current.push(row)
    currentKey = key
  }
  if (current.length > 0) runs.push(current)
  return runs
}

const PIECE_SEPARATOR = '\n\n'

/**
 * Join a run's members into one passage, dropping chunking overlap.
 *
 * The chunker seeds each chunk with the trailing pieces of the one before it
 * (`overlapTail` in chunk.ts), so two consecutive chunks of one long element
 * share text at the junction: the tail of the first is the head of the
 * second, on a paragraph-or-sentence boundary. Joined naively, a parent would
 * say that part twice.
 *
 * The overlap is recognised only in the exact shape the chunker makes it —
 * a suffix of the previous member made of whole pieces, which the next member
 * begins with and then continues past. It is never the whole previous member
 * (the chunker drops a tail that leaves no room, so a chunk is never all
 * overlap), and anything else is kept: a sentence the document genuinely
 * repeats is the document's words, and deleting it would misquote it.
 */
export function mergeRunContent(
  members: readonly { content: string }[],
): string {
  let merged = ''
  let previous: string | null = null

  for (const { content } of members) {
    if (previous === null) {
      merged = content
      previous = content
      continue
    }

    const pieces = previous.split(PIECE_SEPARATOR)
    let appended = false
    // Longest overlap first, never the whole previous member (k >= 1).
    for (let k = 1; k < pieces.length; k++) {
      const tail = pieces.slice(k).join(PIECE_SEPARATOR)
      if (tail.length === 0) continue
      if (content.startsWith(tail + PIECE_SEPARATOR)) {
        merged += content.slice(tail.length)
        appended = true
        break
      }
    }
    if (!appended) merged += PIECE_SEPARATOR + content
    previous = content
  }

  return merged
}

function pageKeyOf(documentId: string, pageNumber: number): string {
  return `${documentId}\u0000${pageNumber}`
}

/**
 * The pages worth loading: those holding two or more admitted, non-figure
 * chunks under an equal section key.
 *
 * A cheap prefilter, not the rule itself — `collapseParents` still decides
 * from the loaded rows whether those chunks are in one contiguous run. What
 * it buys is that the common case (every admitted chunk on its own page or
 * section) and refusal (nothing admitted) never run the extra query at all.
 */
export function pagesToLoad(
  admitted: readonly RetrievedChunk[],
): { documentId: string; pageNumber: number }[] {
  const counts = new Map<string, number>()
  const pages = new Map<string, { documentId: string; pageNumber: number }>()

  for (const chunk of admitted) {
    if (chunk.kind === 'figure') continue
    const page = pageKeyOf(chunk.documentId, chunk.pageNumber)
    const key = `${page}\u0000${sectionKey(chunk)}`
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (count >= 2 && !pages.has(page)) {
      pages.set(page, {
        documentId: chunk.documentId,
        pageNumber: chunk.pageNumber,
      })
    }
  }

  return [...pages.values()]
}

/**
 * The largest parent, summed over the run's stored `token_count`: three
 * chunks' worth. Derived, not configured — a run bigger than that is not one
 * passage. One function so retrieval and the inspector cannot disagree on it.
 */
export function parentMaxTokens(chunkTokens: number): number {
  return 3 * chunkTokens
}

/** Whether a run is small enough to be returned as one parent. */
export function runFitsParent(
  run: readonly { tokenCount: number }[],
  maxTokens: number,
): boolean {
  return run.reduce((sum, row) => sum + row.tokenCount, 0) <= maxTokens
}

export interface CollapseOptions {
  /**
   * Largest parent, summed over the run's stored `token_count`. Derived by the
   * caller with `parentMaxTokens` rather than configured: a run too big to be
   * one passage stays as the separate children the gate admitted.
   */
  maxTokens: number
}

/**
 * Replace admitted children with their parent where the rule says so.
 *
 * - **R0.** Nothing in, nothing out. Refusal stays refusal: assembly can only
 *   rewrite what the gate admitted, never add to an empty list.
 * - A run with two or more admitted members, and a summed size within
 *   `maxTokens`, becomes ONE parent at the list position of its best-ranked
 *   admitted member. The other admitted members are dropped from the list —
 *   their text is inside the parent.
 * - A lone admitted child is returned unchanged. A run over the cap stays as
 *   separate children. Two runs never merge, even on one page.
 *
 * The parent's `similarity` is the best admitted member's real cosine, never a
 * blend: every downstream consumer that re-filters on similarity (the agentic
 * loop's attempt-scaled floor) scores a parent exactly as it scores its best
 * child. The parent's TEXT is the whole run, so a raised floor that keeps the
 * parent keeps members it would have dropped on their own (see `accumulate`).
 */
export function collapseParents(
  admitted: readonly RetrievedChunk[],
  pageRows: readonly PageRow[],
  options: CollapseOptions,
): RetrievedChunk[] {
  if (admitted.length === 0) return []

  const rowsByPage = new Map<string, PageRow[]>()
  for (const row of pageRows) {
    const key = pageKeyOf(row.documentId, row.pageNumber)
    const list = rowsByPage.get(key) ?? []
    list.push(row)
    rowsByPage.set(key, list)
  }

  const runOf = new Map<string, PageRow[]>()
  for (const rows of rowsByPage.values()) {
    for (const run of sectionRuns(rows)) {
      for (const row of run) runOf.set(row.id, run)
    }
  }

  // Which admitted chunks sit in which run.
  const admittedByRun = new Map<PageRow[], RetrievedChunk[]>()
  for (const chunk of admitted) {
    if (chunk.kind === 'figure') continue
    const run = runOf.get(chunk.chunkId)
    // A run's rows must be the chunk's own page; anything else is a loader
    // bug, and the safe answer to it is "no parent".
    if (
      !run ||
      run[0]?.documentId !== chunk.documentId ||
      run[0]?.pageNumber !== chunk.pageNumber
    ) {
      continue
    }
    const list = admittedByRun.get(run) ?? []
    list.push(chunk)
    admittedByRun.set(run, list)
  }

  const parents = new Map<PageRow[], RetrievedChunk>()
  for (const [run, members] of admittedByRun) {
    if (members.length < 2) continue
    if (!runFitsParent(run, options.maxTokens)) continue

    const best = members[0] as RetrievedChunk
    const first = run[0] as PageRow
    parents.set(run, {
      ...best,
      chunkId: first.id,
      content: mergeRunContent(run),
      similarity: Math.max(...members.map((m) => m.similarity)),
      kind: run.some((row) => row.kind === 'ocr') ? 'ocr' : 'text',
      heading: first.heading,
      headingBbox: first.headingBbox,
      memberChunkIds: run.map((row) => row.id),
      assembledFrom: members.length,
    })
  }

  if (parents.size === 0) return [...admitted]

  const out: RetrievedChunk[] = []
  const emitted = new Set<PageRow[]>()
  for (const chunk of admitted) {
    const run = chunk.kind === 'figure' ? undefined : runOf.get(chunk.chunkId)
    const parent = run ? parents.get(run) : undefined
    if (!run || !parent) {
      out.push(chunk)
      continue
    }
    // The best-ranked member's slot holds the parent; the rest are inside it.
    if (emitted.has(run)) continue
    emitted.add(run)
    out.push(parent)
  }
  return out
}

/** A page row as the citation route reads it, with its stored geometry. */
export interface BoxedPageRow extends SectionRow {
  boxes: unknown
  bbox: unknown
}

/**
 * The boxes of the run that contains `chunkId`, as a LIST — or null when the
 * chunk is not in any run (a figure, or a row that is gone).
 *
 * Concatenated, never unioned: two paragraphs of one section can sit in two
 * columns, and the union of their boxes covers the gutter and the other
 * column. No box beats a wrong box (spec 0035). Every box is on one page,
 * because runs are single-page (NFR3).
 */
export function parentRunBoxes(
  pageRows: readonly BoxedPageRow[],
  chunkId: string,
): CitationBox[] | null {
  const run = sectionRuns(pageRows).find((r) =>
    r.some((row) => row.id === chunkId),
  )
  if (!run) return null
  return run.flatMap((row) => toCitationBoxes(row.boxes, row.bbox))
}
