import 'server-only'

import { env } from '@/lib/env'
import type { PageText } from './chunk'

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

export async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
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

  if (isImageOnly(pages, env.RAG_MIN_CHARS_PER_PAGE)) {
    throw new ExtractionError(
      'No selectable text found — this looks like a scanned PDF. OCR is not supported yet, so it cannot be added to your knowledge base.',
    )
  }

  return { pages: pages.filter((p) => p.text.length > 0), pageCount }
}
