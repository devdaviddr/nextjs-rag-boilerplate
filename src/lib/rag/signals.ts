import 'server-only'

import type { ChunkBox } from '@/db/schema'
import type { PositionedItem } from './chunk'
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
 * A page's box and rotation, as pdf.js reports them.
 *
 * `view` is the MediaBox in PDF units — NOT necessarily anchored at the
 * origin, which is why the offsets are carried rather than assumed to be zero.
 */
export interface PageGeometry {
  view: readonly [number, number, number, number]
  /** `/Rotate`, in degrees clockwise. Anything but 0/90/180/270 is ignored. */
  rotation: number
}

/**
 * Text-layer items with their boxes converted to the one convention
 * (spec 0035 FR2): normalised 0–1, origin TOP-left.
 *
 * Three conversions happen here, once, at ingestion, so that nothing
 * downstream ever has to ask which path produced a box:
 *
 * 1. **The y-axis flips.** PDF's user space has its origin at the bottom-left
 *    and `extractTextItems` reports it verbatim; `nemotron-parse` returns
 *    top-left. Storing both and converting at read time would mean a consumer
 *    has to know how a chunk was made before it can draw its box, which is
 *    handing it the problem instead of a solution.
 * 2. **The page's own origin is subtracted**, because a MediaBox does not have
 *    to start at (0, 0).
 * 3. **Rotation is applied**, using the same mapping pdf.js's own viewport
 *    uses. A `/Rotate 90` page renders — and is parsed by the cracked path —
 *    turned; leaving the text layer untransformed would put every box from
 *    the free path at ninety degrees to every box from the paid one.
 *
 * An item with degenerate geometry keeps its text and loses its box, rather
 * than being dropped: the character sequence is what maps a chunk back onto
 * the page, and a hole in it would shift every offset after it.
 */
export function toPositionedItems(
  items: readonly TextItem[],
  geometry: PageGeometry,
): PositionedItem[] {
  const [x0, y0, x1, y1] = geometry.view
  const width = Math.abs(x1 - x0)
  const height = Math.abs(y1 - y0)
  const rotation =
    (((Math.round(geometry.rotation / 90) * 90) % 360) + 360) % 360
  const swapped = rotation === 90 || rotation === 270
  const pageWidth = swapped ? height : width
  const pageHeight = swapped ? width : height

  /** One corner, PDF user space to normalised top-left. */
  const project = (x: number, y: number): [number, number] => {
    const dx = x - Math.min(x0, x1)
    const dy = y - Math.min(y0, y1)
    switch (rotation) {
      case 90:
        return [dy, dx]
      case 180:
        return [width - dx, height - dy]
      case 270:
        return [height - dy, width - dx]
      default:
        // Unrotated: only the y-axis flips.
        return [dx, height - dy]
    }
  }

  return items.map((item) => {
    const usable =
      pageWidth > 0 &&
      pageHeight > 0 &&
      Number.isFinite(item.x) &&
      Number.isFinite(item.y) &&
      Math.abs(item.width) > 0 &&
      Math.abs(item.height) > 0

    if (!usable) return { str: item.str, box: null }

    // `y` is the baseline and `height` the glyph height, so the item's box
    // runs upward from the baseline in PDF space.
    const [ax, ay] = project(item.x, item.y)
    const [bx, by] = project(
      item.x + Math.abs(item.width),
      item.y + Math.abs(item.height),
    )
    const clamp = (n: number) => Math.min(1, Math.max(0, n))
    const box: ChunkBox = {
      xmin: clamp(Math.min(ax, bx) / pageWidth),
      ymin: clamp(Math.min(ay, by) / pageHeight),
      xmax: clamp(Math.max(ax, bx) / pageWidth),
      ymax: clamp(Math.max(ay, by) / pageHeight),
    }
    if (box.xmax <= box.xmin || box.ymax <= box.ymin) {
      return { str: item.str, box: null }
    }
    return { str: item.str, box }
  })
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
 * Every page's raw text items, in PDF user space.
 *
 * Tolerant by design. Positioned items are an enhancement, not a requirement:
 * without them a page still gets a char count, which is enough to separate
 * `no-text` from the rest — the routing decision that matters most — and a
 * chunk simply carries no box, which spec 0035 FR4 already requires to work.
 */
export async function readTextItems(pdf: unknown): Promise<TextItem[][]> {
  const { extractTextItems } = await import('unpdf')
  try {
    const result = await extractTextItems(
      pdf as Parameters<typeof extractTextItems>[0],
    )
    return result.items as unknown as TextItem[][]
  } catch {
    return []
  }
}

/**
 * Every page's text items with boxes in the shared convention (spec 0035 FR1).
 *
 * `raw` is accepted so a caller that has already read the items does not read
 * them twice — the same reason `collectPageSignals` takes `pageTexts` rather
 * than re-extracting them.
 */
export async function positionedItemsByPage(
  pdf: unknown,
  raw?: TextItem[][],
): Promise<PositionedItem[][]> {
  const itemsByPage = raw ?? (await readTextItems(pdf))
  const proxy = pdf as {
    numPages: number
    getPage: (n: number) => Promise<{ view: number[]; rotate?: number }>
  }

  const out: PositionedItem[][] = []
  for (let pageNumber = 1; pageNumber <= proxy.numPages; pageNumber++) {
    const items = itemsByPage[pageNumber - 1] ?? []
    if (items.length === 0) {
      out.push([])
      continue
    }
    try {
      const page = await proxy.getPage(pageNumber)
      const view = page.view
      out.push(
        toPositionedItems(items, {
          view: [view[0] ?? 0, view[1] ?? 0, view[2] ?? 612, view[3] ?? 792],
          rotation: page.rotate ?? 0,
        }),
      )
    } catch {
      // A page whose dimensions cannot be read cannot be normalised against
      // them. Guessing Letter here would put the boxes in the wrong place,
      // which is worse than having none.
      out.push(items.map((item) => ({ str: item.str, box: null })))
    }
  }
  return out
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
  const { getResolvedPDFJS } = await import('unpdf')
  const itemsByPage = await readTextItems(pdf)

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
