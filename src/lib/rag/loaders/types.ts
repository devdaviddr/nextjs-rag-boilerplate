import type { CrackOptions, DocumentChunks } from '../crack'

/**
 * One document format (spec 0046): how to recognise its bytes and how to turn
 * them into chunks. Everything after chunking (embedding, retrieval, parents,
 * citations) is shared by every format.
 */
export interface DocumentLoader {
  /** Shown in errors and the upload help, e.g. "Word document". */
  label: string
  /** What is stored as the file's MIME type, whatever the browser claimed. */
  mimeType: string
  /** For the file picker's `accept`, e.g. `.docx`. */
  extensions: readonly string[]
  /** What a citation calls a location: a PDF's page, a text file's section. */
  unit: 'page' | 'section'
  /** Whether these bytes are this format. Decides, not the file's name. */
  sniff(bytes: Buffer): boolean
  toChunks(bytes: Buffer, options: CrackOptions): Promise<DocumentChunks>
}
