import 'server-only'

import { env } from '@/lib/env'
import type { PageText, PositionedItem } from './chunk'
import { positionedItemsByPage } from './signals'

/**
 * PDF text extraction (spec 0025 FR5).
 *
 * In-process with `unpdf` — no sidecar container, works offline. The trade is
 * that image-only (scanned) PDFs have no text layer to extract, so they are
 * DETECTED AND REJECTED rather than silently ingested as a handful of empty
 * chunks. A knowledge base that quietly contains nothing is worse than one
 * that refuses the upload.
 */

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractionError'
  }
}

export interface ExtractionResult {
  pages: PageText[]
  pageCount: number
  /**
   * Every page's text in order, INCLUDING the empty ones (spec 0031).
   *
   * `pages` above drops empties, which is right for the text-layer path and
   * wrong for cracking: an empty entry is a scanned page, and dropping it
   * renumbers every page after it. A citation pointing at the wrong page is
   * worse than one pointing at nothing.
   */
  allPageTexts: string[]
  /**
   * Every page's positioned text items, in the same full page sequence as
   * `allPageTexts` (spec 0035 FR1).
   *
   * Exposed as well as attached to `pages` because the cracked path builds its
   * own `PageText` objects from `allPageTexts` and needs somewhere to get the
   * matching items from; without them its text-layer pages fall back to
   * page-level citations, which is FR4's behaviour and not a failure.
   */
  itemsByPage: PositionedItem[][]
  /**
   * The open pdf.js document, so a caller that goes on to crack pages renders
   * from the same proxy rather than re-parsing the file.
   */
  pdf: unknown
}

/**
 * True when the extracted text is too sparse to be a real text layer.
 * Averaged across pages so a legitimate document with a few image-only pages
 * (a cover, a chart) still ingests.
 */
export function isImageOnly(
  pages: PageText[],
  minCharsPerPage: number,
): boolean {
  if (pages.length === 0) return true
  const total = pages.reduce((sum, p) => sum + p.text.trim().length, 0)
  return total / pages.length < minCharsPerPage
}

export async function extractPdf(
  buffer: Buffer,
  {
    /**
     * Skip the image-only rejection (spec 0031 FR1).
     *
     * The rejection exists because a knowledge base that quietly contains
     * nothing is worse than one that refuses an upload. Once pages can be
     * cracked individually that reasoning inverts: a scanned page is readable,
     * so refusing the document is the behaviour that loses information.
     */
    allowImageOnly = false,
  }: { allowImageOnly?: boolean } = {},
): Promise<ExtractionResult> {
  // Imported lazily so the PDF machinery is not pulled into every route that
  // happens to touch this module's siblings.
  const { extractText, getDocumentProxy } = await import('unpdf')

  let pdf
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer))
  } catch {
    throw new ExtractionError(
      'This file could not be opened as a PDF. It may be corrupt or password-protected.',
    )
  }

  const pageCount = pdf.numPages
  if (pageCount > env.RAG_MAX_DOCUMENT_PAGES) {
    throw new ExtractionError(
      `This PDF has ${pageCount} pages, over the ${env.RAG_MAX_DOCUMENT_PAGES}-page limit.`,
    )
  }

  const { text } = await extractText(pdf, { mergePages: false })
  const pages: PageText[] = (text as string[]).map((pageText, i) => ({
    pageNumber: i + 1,
    text: (pageText ?? '').replace(/\r\n/g, '\n').trim(),
  }))

  if (!allowImageOnly && isImageOnly(pages, env.RAG_MIN_CHARS_PER_PAGE)) {
    throw new ExtractionError(
      'No selectable text found — this looks like a scanned PDF. OCR is not supported yet, so it cannot be added to your knowledge base.',
    )
  }

  // Read AFTER the rejections above, so a file that is not going to be ingested
  // never pays for a second pass over its text layer.
  const itemsByPage = await positionedItemsByPage(pdf)

  return {
    pages: pages
      .filter((p) => p.text.length > 0)
      .map((p) => {
        const items = itemsByPage[p.pageNumber - 1]
        return items && items.length > 0 ? { ...p, items } : p
      }),
    pageCount,
    allPageTexts: pages.map((p) => p.text),
    itemsByPage,
    pdf,
  }
}
