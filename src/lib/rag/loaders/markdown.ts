import {
  SECTION_DEPTH,
  type SectionElements,
  asText,
  sectionsToChunks,
} from './sections'
import type { DocumentLoader } from './types'

/**
 * Markdown into sections at headings (spec 0046 FR3). Plain text is Markdown
 * without headings: one section. Deliberately a line scanner, not a full
 * Markdown parser: what matters is headings, lists, tables and code blocks,
 * each kept whole, in order.
 */
export function markdownSections(text: string): SectionElements[] {
  const sections: SectionElements[] = [[]]
  let paragraph: string[] = []
  let table: string[] = []
  let fence: string[] | null = null

  const current = () => sections[sections.length - 1]!
  const flush = () => {
    if (paragraph.length)
      current().push({ type: 'Text', text: paragraph.join(' ') })
    if (table.length) current().push({ type: 'Table', text: table.join('\n') })
    paragraph = []
    table = []
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (fence) {
      if (/^\s*(```|~~~)/.test(line)) {
        current().push({ type: 'Table', text: fence.join('\n') })
        fence = null
      } else fence.push(line)
      continue
    }
    if (/^\s*(```|~~~)/.test(line)) {
      flush()
      fence = []
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*$/)
    if (heading) {
      flush()
      if (heading[1]!.length <= SECTION_DEPTH && current().length > 0)
        sections.push([])
      current().push({ type: 'Section-header', text: heading[2]! })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (paragraph.length) flush()
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.push(line.trim())
      continue
    }
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (item) {
      flush()
      current().push({ type: 'List-item', text: item[1]! })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (table.length) flush()
    paragraph.push(line.trim())
  }
  if (fence) current().push({ type: 'Table', text: fence.join('\n') })
  flush()
  return sections
}

export const markdownLoader: DocumentLoader = {
  label: 'Markdown or text file',
  mimeType: 'text/markdown',
  extensions: ['.md', '.markdown', '.txt'],
  unit: 'section',
  // Any UTF-8 text that no more specific loader claimed.
  sniff: (bytes) => asText(bytes) !== null,
  async toChunks(bytes, options) {
    return sectionsToChunks(markdownSections(asText(bytes) ?? ''), options)
  },
}
