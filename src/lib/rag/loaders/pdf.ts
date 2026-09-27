import { chunksFromPdf } from '../crack'
import type { DocumentLoader } from './types'

/** PDF (spec 0046 FR2): the existing pipeline, cracking included, unchanged. */
export const pdfLoader: DocumentLoader = {
  label: 'PDF',
  mimeType: 'application/pdf',
  extensions: ['.pdf'],
  unit: 'page',
  sniff: (bytes) => bytes.subarray(0, 1024).includes('%PDF-'),
  toChunks: chunksFromPdf,
}
