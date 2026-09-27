import { docxLoader } from './docx'
import { htmlLoader } from './html'
import { markdownLoader } from './markdown'
import { pdfLoader } from './pdf'
import type { DocumentLoader } from './types'

export type { DocumentLoader } from './types'

/**
 * The formats a knowledge base accepts (spec 0046), most specific first:
 * bytes are offered to each in turn and the first to recognise them wins.
 * Markdown is last because it accepts any text. Add a format here.
 */
export const documentLoaders: readonly DocumentLoader[] = [
  pdfLoader,
  docxLoader,
  htmlLoader,
  markdownLoader,
]

/** The loader for these bytes, or null when no format recognises them. */
export function loaderForBytes(bytes: Buffer): DocumentLoader | null {
  return documentLoaders.find((loader) => loader.sniff(bytes)) ?? null
}

/** The loader for a stored MIME type. Anything unknown is treated as PDF. */
export function loaderForMimeType(mimeType: string | null | undefined) {
  return documentLoaders.find((l) => l.mimeType === mimeType) ?? pdfLoader
}

/** Every accepted MIME type and extension, for validation and the picker. */
export const DOCUMENT_TYPES = documentLoaders.map((l) => l.mimeType)
export const DOCUMENT_EXTENSIONS = documentLoaders.flatMap((l) => l.extensions)
