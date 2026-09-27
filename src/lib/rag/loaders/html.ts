import { type HTMLElement, parse } from 'node-html-parser'

import {
  SECTION_DEPTH,
  type SectionElements,
  asText,
  sectionsToChunks,
} from './sections'
import type { DocumentLoader } from './types'

/** Never content: dropped with everything inside them (spec 0046 FR4). */
const DROP =
  'script, style, noscript, template, svg, nav, header, footer, aside, form, iframe'

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * HTML into sections at `h1`–`h3` (spec 0046 FR4). Text only: no script runs
 * and nothing linked is fetched; the parser never executes anything.
 */
export function htmlSections(html: string): SectionElements[] {
  const root = parse(html, { comment: false, blockTextElements: { pre: true } })
  for (const node of root.querySelectorAll(DROP)) node.remove()
  const body =
    root.querySelector('main') ??
    root.querySelector('article') ??
    root.querySelector('body') ??
    root

  const sections: SectionElements[] = [[]]
  const current = () => sections[sections.length - 1]!
  const walk = (node: HTMLElement) => {
    for (const child of node.childNodes as HTMLElement[]) {
      const tag = child.rawTagName?.toLowerCase()
      if (!tag) {
        const text = collapse(child.text ?? '')
        if (text) current().push({ type: 'Text', text })
        continue
      }
      const level = /^h([1-6])$/.exec(tag)?.[1]
      if (level) {
        const text = collapse(child.text)
        if (!text) continue
        if (Number(level) <= SECTION_DEPTH && current().length > 0)
          sections.push([])
        current().push({ type: 'Section-header', text })
      } else if (
        tag === 'p' ||
        tag === 'blockquote' ||
        tag === 'dd' ||
        tag === 'dt'
      ) {
        const text = collapse(child.text)
        if (text) current().push({ type: 'Text', text })
      } else if (tag === 'li') {
        const text = collapse(child.text)
        if (text) current().push({ type: 'List-item', text })
      } else if (tag === 'pre') {
        if (child.text.trim())
          current().push({ type: 'Table', text: child.text.trim() })
      } else if (tag === 'table') {
        const rows = child
          .querySelectorAll('tr')
          .map((tr) =>
            tr
              .querySelectorAll('th, td')
              .map((c) => collapse(c.text))
              .join(' | '),
          )
          .filter(Boolean)
        if (rows.length)
          current().push({ type: 'Table', text: rows.join('\n') })
      } else {
        walk(child)
      }
    }
  }
  walk(body)
  return sections
}

/** The page's `<title>`, for the document's name when there is one. */
export function htmlTitle(html: string): string | undefined {
  return collapse(parse(html).querySelector('title')?.text ?? '') || undefined
}

export const htmlLoader: DocumentLoader = {
  label: 'HTML page',
  mimeType: 'text/html',
  extensions: ['.html', '.htm'],
  unit: 'section',
  sniff(bytes) {
    const head = asText(bytes.subarray(0, 4096))
    return head !== null && /<(!doctype html|html|head|body)[\s>]/i.test(head)
  },
  async toChunks(bytes, options) {
    return sectionsToChunks(htmlSections(asText(bytes) ?? ''), options)
  },
}
