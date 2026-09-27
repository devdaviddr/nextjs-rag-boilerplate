import mammoth from 'mammoth'

import { htmlSections } from './html'
import { sectionsToChunks } from './sections'
import type { DocumentLoader } from './types'

/** A `.docx` is a zip whose central directory names `word/document.xml`. */
function isDocx(bytes: Buffer): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04 &&
    bytes.includes('word/document.xml')
  )
}

/**
 * Word documents (spec 0046 FR5): converted to HTML, headings from their
 * paragraph styles and tables kept, then read by the HTML loader. Mammoth
 * reads the document's XML; it runs no macros and ignores embedded objects.
 */
export const docxLoader: DocumentLoader = {
  label: 'Word document',
  mimeType:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extensions: ['.docx'],
  unit: 'section',
  sniff: isDocx,
  async toChunks(bytes, options) {
    const { value: html } = await mammoth.convertToHtml({ buffer: bytes })
    return sectionsToChunks(htmlSections(html), options)
  },
}
