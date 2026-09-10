import 'server-only'

import type { PageSignals } from './triage'

/**
 * Gathering the evidence `triage.ts` judges (spec 0031 Stage 0).
 *
 * Split from `triage.ts` on purpose: this half touches `unpdf` and a live PDF,
 * the other half is a pure decision that can be unit-tested exhaustively. The
 * seam is `PageSignals` — six numbers per page.
 *
 * Everything here is free. No API call has been made by the time these signals
 * exist, which is what lets routing decide whether to spend one.
 */

interface TextItem {
  str: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * Operators that mean "something was drawn here".
 *
 * Resolved by NAME from pdf.js's own `OPS` table rather than by opcode: the
 * numbers are an internal detail and a version bump could renumber them
 * silently, which is exactly the kind of quiet breakage this pipeline is
 * supposed to avoid.
 */
const RASTER_OPS = [
  'paintImageXObject',
  'paintImageXObjectRepeat',
  'paintInlineImageXObject',
  'paintImageMaskXObject',
  'paintJpegXObject',
] as const

const VECTOR_OPS = ['constructPath', 'rawFillPath', 'shadingFill'] as const

/**
 * Cluster item centres into columns.
 *
 * **Whitespace-only items are excluded, and that is load-bearing.** pdf.js
 * emits synthetic spacing items between columns — on the eval corpus a
 * two-column page produced `x=215.1 w=114.9 " "` sitting exactly in the
 * gutter. Those fillers bridge the gap between the two clusters, so every
 * measured gap falls under the threshold and a two-column page reports as one.
 * That is what routed an interleaved page to the free path.
 */
export function countColumns(
  items: readonly { str?: string; x: number; width: number }[],
  pageWidth: number,
  columnGap = 0.15,
): number {
  if (items.length === 0 || pageWidth <= 0) return 0

  const centres = items
    .filter((item) => (item.str ?? '').trim().length > 0)
    .filter((item) => item.width / pageWidth <= 0.6)
    .map((item) => (item.x + item.width / 2) / pageWidth)
    .sort((a, b) => a - b)

  if (centres.length === 0) return 1

  let columns = 1
  for (let i = 1; i < centres.length; i++) {
    const previous = centres[i - 1] as number
    const current = centres[i] as number
    if (current - previous > columnGap) columns++
  }
  return columns
}

/** Share of the page covered by text item boxes, clamped to 0..1. */
export function textAreaRatio(
  items: readonly { width: number; height: number }[],
  pageWidth: number,
  pageHeight: number,
): number {
  const pageArea = pageWidth * pageHeight
  if (pageArea <= 0) return 0
  const covered = items.reduce(
    (sum, item) => sum + Math.abs(item.width) * Math.abs(item.height),
    0,
  )
  // Items overlap (a line's box can cover its neighbours'), so this is a
  // coverage estimate, not a measurement. Triage only needs the order of
  // magnitude — dense versus sparse — so clamping is honest here.
  return Math.min(1, covered / pageArea)
}

/** Raster and vector drawing counts for one page, from its operator list. */
export function countDrawOps(
  fnArray: readonly number[],
  ops: Record<string, number>,
): { imageCount: number; vectorOpCount: number } {
  const codesFor = (names: readonly string[]) =>
    new Set(
      names
        .map((name) => ops[name])
        .filter((code): code is number => typeof code === 'number'),
    )
  const raster = codesFor(RASTER_OPS)
  const vector = codesFor(VECTOR_OPS)

  let imageCount = 0
  let vectorOpCount = 0
  for (const fn of fnArray) {
    if (raster.has(fn)) imageCount++
    else if (vector.has(fn)) vectorOpCount++
  }
  return { imageCount, vectorOpCount }
}

/**
 * Signals for every page of a document, in page order.
 *
 * `pageTexts` is what `extractPdf` already pulled out, passed in rather than
 * re-extracted: the text layer is the single most important signal and there is
 * no reason to read it twice.
 *
 * Both drawing counts come from one `getOperatorList()` pass rather than from
 * `extractImages`, which decodes every image's pixels just to count them —
 * work that would be thrown away, on the path whose whole job is to be free.
 */
export async function collectPageSignals(
  pdf: unknown,
  pageTexts: readonly string[],
): Promise<PageSignals[]> {
  const { extractTextItems, getResolvedPDFJS } = await import('unpdf')

  let itemsByPage: TextItem[][] = []
  try {
    const result = await extractTextItems(
      pdf as Parameters<typeof extractTextItems>[0],
    )
    itemsByPage = result.items as unknown as TextItem[][]
  } catch {
    // Positioned items are an enhancement, not a requirement. Without them
    // every page still gets a char count, which is enough to separate
    // `no-text` from the rest — the routing decision that matters most.
    itemsByPage = []
  }

  const { OPS } = (await getResolvedPDFJS()) as unknown as {
    OPS: Record<string, number>
  }

  const proxy = pdf as {
    numPages: number
    getPage: (n: number) => Promise<{
      view: number[]
      getOperatorList: () => Promise<{ fnArray: number[] }>
    }>
  }

  const signals: PageSignals[] = []
  for (let pageNumber = 1; pageNumber <= proxy.numPages; pageNumber++) {
    const items = itemsByPage[pageNumber - 1] ?? []

    let pageWidth = 612
    let pageHeight = 792
    let imageCount = 0
    let vectorOpCount = 0

    try {
      const page = await proxy.getPage(pageNumber)
      const view = page.view
      pageWidth = Math.abs((view[2] ?? 612) - (view[0] ?? 0)) || 612
      pageHeight = Math.abs((view[3] ?? 792) - (view[1] ?? 0)) || 792
      const { fnArray } = await page.getOperatorList()
      const counts = countDrawOps(fnArray, OPS)
      imageCount = counts.imageCount
      vectorOpCount = counts.vectorOpCount
    } catch {
      // A page whose operators cannot be read is treated as plain text and
      // falls back to Letter dimensions. Under-counting routes it to the cheap
      // path, which is the safe direction: the text layer is still read.
    }

    signals.push({
      charCount: (pageTexts[pageNumber - 1] ?? '').trim().length,
      itemCount: items.length,
      imageCount,
      vectorOpCount,
      columnCount: countColumns(items, pageWidth),
      textAreaRatio: textAreaRatio(items, pageWidth, pageHeight),
    })
  }

  return signals
}
