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
  /**
   * Point size, as `unpdf` reports it (spec 0039).
   *
   * The one signal that separates a heading from a paragraph without a layout
   * model — and it was being discarded one function below, which is why the
   * text-layer path could see no structure at all.
   */
  fontSize?: number
  /** True on the last item of a visual line, so lines need not be inferred. */
  hasEOL?: boolean
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

    const typography = {
      ...(Number.isFinite(item.fontSize) && (item.fontSize ?? 0) > 0
        ? { fontSize: item.fontSize }
        : {}),
      ...(item.hasEOL === true ? { endsLine: true } : {}),
    }

    if (!usable) return { str: item.str, box: null, ...typography }

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
      return { str: item.str, box: null, ...typography }
    }
    return { str: item.str, box, ...typography }
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
 * Where each vector operator carries its `[xMin, yMin, xMax, yMax]` box, as an
 * index into that operator's arguments. From pdf.js's own emitters:
 * `constructPath` is pushed as `[ops, [coords], minMax]` and the merged
 * `rawFillPath` as `[[coords], minMax]`. `shadingFill` carries no box at all
 * and so is deliberately absent — an operator with no bounds is always
 * counted, which is the safe direction.
 */
const BOUNDS_ARG_INDEX: Readonly<Record<string, number>> = {
  constructPath: 2,
  rawFillPath: 1,
}

/**
 * What separates a page template from page content, in page-relative units.
 *
 * A **rule** is a line that spans the text column — a header underline, a
 * footer divider, the line under a section title. A chart's axes and a table's
 * cell borders are drawn the same way but are narrower, which is the whole
 * discrimination: measured on `~/Desktop/rag-cracking-test.pdf`, the running
 * header/footer rules span 0.827 of the page and are 0.001 tall, while the
 * widest thing the chart on page 4 draws is 0.656 and the widest table rule is
 * 0.400.
 *
 * A **frame** is the border or background box a template draws around the
 * whole content area. That same document draws one on every page at
 * 0.847 x 0.878; nothing that carries information is that size.
 */
const RULE_MIN_WIDTH = 0.6
const RULE_MAX_HEIGHT = 0.01
const FRAME_MIN_SIDE = 0.8

/** A 2-D affine matrix in PDF's `[a, b, c, d, e, f]` order. */
type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** `m` concatenated onto `ctm`, matching PDF's `cm`: CTM' = m x CTM. */
function concat(m: Matrix, ctm: Matrix): Matrix {
  return [
    m[0] * ctm[0] + m[1] * ctm[2],
    m[0] * ctm[1] + m[1] * ctm[3],
    m[2] * ctm[0] + m[3] * ctm[2],
    m[2] * ctm[1] + m[3] * ctm[3],
    m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
    m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
  ]
}

/** A six-number array-like as a matrix, or null if it is not one. */
function asMatrix(value: unknown): Matrix | null {
  if (!isNumberArray(value, 6)) return null
  return [value[0], value[1], value[2], value[3], value[4], value[5]] as Matrix
}

function isNumberArray(value: unknown, length: number): value is number[] {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as ArrayLike<unknown>
  if (candidate.length !== length) return false
  for (let i = 0; i < length; i++) {
    if (!Number.isFinite(candidate[i] as number)) return false
  }
  return true
}

/**
 * Is this drawing operation part of the page template rather than its content?
 *
 * **The reason this exists.** `vectorOpCount` was counted blind, and every
 * corporate PDF carries a ruled header, a ruled footer and often a border box
 * on every single page. Six such operations is the threshold at which triage
 * decides a page is drawing something, so on a realistically styled document
 * ordinary prose pages cleared it on furniture alone and NFR1's "only pages
 * that need help cost a call" stopped holding. The eval corpus never showed
 * this because its fixtures have no page template at all.
 *
 * Bounds arrive in the space the path was constructed in, NOT in page space —
 * on the same document a header rule reports an x range of 8..665 on a
 * 596-point page — so the caller tracks the CTM and the box is transformed
 * before it is measured. Anything whose geometry cannot be established is
 * counted, because under-counting hides a figure and that is the failure this
 * pipeline exists to fix.
 */
function isPageFurniture(
  name: string,
  args: unknown,
  ctm: Matrix,
  pageWidth: number,
  pageHeight: number,
): boolean {
  if (pageWidth <= 0 || pageHeight <= 0) return false

  const index = BOUNDS_ARG_INDEX[name]
  if (index === undefined) return false
  const bounds = (args as ArrayLike<unknown> | undefined)?.[index]
  if (!isNumberArray(bounds, 4)) return false

  const [xMin, yMin, xMax, yMax] = bounds as [number, number, number, number]
  // All four corners, because a rotated CTM turns a wide box into a tall one.
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [xMin, yMin],
    [xMax, yMin],
    [xMin, yMax],
    [xMax, yMax],
  ] as const) {
    xs.push(ctm[0] * x + ctm[2] * y + ctm[4])
    ys.push(ctm[1] * x + ctm[3] * y + ctm[5])
  }

  const width = (Math.max(...xs) - Math.min(...xs)) / pageWidth
  const height = (Math.max(...ys) - Math.min(...ys)) / pageHeight

  const isRule = width >= RULE_MIN_WIDTH && height <= RULE_MAX_HEIGHT
  const isFrame = width >= FRAME_MIN_SIDE && height >= FRAME_MIN_SIDE
  return isRule || isFrame
}

/**
 * Does this item carry text, or is it one of pdf.js's synthetic spacers?
 *
 * **Excluding the spacers is load-bearing in two places.** pdf.js emits
 * zero-height whitespace items between runs — on the eval corpus a two-column
 * page produced `x=215.1 w=114.9 " "` sitting exactly in the gutter, and on a
 * word-granular producer every inter-word gap is one of these.
 */
const hasText = (item: { str?: string }): boolean =>
  (item.str ?? '').trim().length > 0

/**
 * Cluster item centres into columns.
 *
 * Whitespace-only items are excluded because those fillers bridge the gap
 * between the two clusters, so every measured gap falls under the threshold
 * and a two-column page reports as one. That is what routed an interleaved
 * page to the free path.
 */
export function countColumns(
  items: readonly { str?: string; x: number; width: number }[],
  pageWidth: number,
  columnGap = 0.15,
): number {
  if (items.length === 0 || pageWidth <= 0) return 0

  const centres = items
    .filter(hasText)
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

/**
 * Raster and vector drawing counts for one page, from its operator list.
 *
 * `vectorOpCount` counts only operations that draw **content**: the page
 * template's rules and frames are discounted, per `isPageFurniture`. Doing
 * that needs each path's box in page coordinates, which needs the CTM in force
 * when the path was drawn, which is why this walks the operator list keeping a
 * graphics-state stack instead of just tallying opcodes.
 */
export function countDrawOps(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  ops: Record<string, number>,
  pageWidth: number,
  pageHeight: number,
): { imageCount: number; vectorOpCount: number } {
  const raster = new Set(
    RASTER_OPS.map((name) => ops[name]).filter(
      (code): code is number => typeof code === 'number',
    ),
  )
  const vectorNameByCode = new Map<number, string>()
  for (const name of VECTOR_OPS) {
    const code = ops[name]
    if (typeof code === 'number') vectorNameByCode.set(code, name)
  }

  // Read once. An OPS table missing one of these leaves the code `undefined`,
  // which no numeric operator can equal — so the CTM simply stops being
  // tracked rather than being tracked wrongly.
  const { save, restore, transform } = ops
  const formBegin = ops.paintFormXObjectBegin
  const formEnd = ops.paintFormXObjectEnd

  let ctm: Matrix = IDENTITY
  const stack: Matrix[] = []

  let imageCount = 0
  let vectorOpCount = 0

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i] as number

    if (fn === save) {
      stack.push(ctm)
      continue
    }
    if (fn === restore || fn === formEnd) {
      ctm = stack.pop() ?? IDENTITY
      continue
    }
    if (fn === formBegin) {
      stack.push(ctm)
      const matrix = asMatrix((argsArray[i] as ArrayLike<unknown>)?.[0])
      if (matrix) ctm = concat(matrix, ctm)
      continue
    }
    if (fn === transform) {
      const matrix = asMatrix(argsArray[i])
      if (matrix) ctm = concat(matrix, ctm)
      continue
    }

    if (raster.has(fn)) {
      imageCount++
      continue
    }

    const name = vectorNameByCode.get(fn)
    if (name === undefined) continue
    if (!isPageFurniture(name, argsArray[i], ctm, pageWidth, pageHeight)) {
      vectorOpCount++
    }
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
      getOperatorList: () => Promise<{
        fnArray: number[]
        argsArray: unknown[]
      }>
    }>
  }

  const signals: PageSignals[] = []
  for (let pageNumber = 1; pageNumber <= proxy.numPages; pageNumber++) {
    // The same whitespace fillers `countColumns` has to ignore also inflate
    // `itemCount` while contributing no area to `textAreaRatio` — and triage
    // divides one by the other. On a word-granular producer more than half the
    // items on a prose page are these, which doubled its apparent density and
    // made ordinary prose read as tabular.
    const items = (itemsByPage[pageNumber - 1] ?? []).filter(hasText)

    let pageWidth = 612
    let pageHeight = 792
    let imageCount = 0
    let vectorOpCount = 0

    try {
      const page = await proxy.getPage(pageNumber)
      const view = page.view
      pageWidth = Math.abs((view[2] ?? 612) - (view[0] ?? 0)) || 612
      pageHeight = Math.abs((view[3] ?? 792) - (view[1] ?? 0)) || 792
      const { fnArray, argsArray } = await page.getOperatorList()
      const counts = countDrawOps(
        fnArray,
        argsArray,
        OPS,
        pageWidth,
        pageHeight,
      )
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
