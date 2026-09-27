import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

// Spec 0046: document loaders. The PDF loader is today's pipeline and is
// covered by the ingestion tests; these cover recognising bytes and turning
// Markdown, HTML and Word into sections.
vi.mock('@/lib/env', () => ({ env: {} }))
vi.mock('@/db', () => ({ db: {} }))

import { htmlSections } from '@/lib/rag/loaders/html'
import {
  DOCUMENT_EXTENSIONS,
  documentLoaders,
  loaderForBytes,
  loaderForMimeType,
} from '@/lib/rag/loaders'
import { markdownSections } from '@/lib/rag/loaders/markdown'
import { DOCUMENT_ACCEPT } from '@/lib/rag/constants'

const fixture = (name: string) => readFileSync(`tests/e2e/fixtures/${name}`)
const options = { chunkTokens: 512, overlapTokens: 64 }

describe('recognising uploads by their bytes (FR6)', () => {
  it('picks each format from its content, not its name', () => {
    expect(loaderForBytes(fixture('handbook.pdf'))?.label).toBe('PDF')
    expect(loaderForBytes(fixture('leave-policy.docx'))?.label).toBe(
      'Word document',
    )
    expect(loaderForBytes(fixture('leave-policy.html'))?.label).toBe(
      'HTML page',
    )
    expect(loaderForBytes(fixture('leave-policy.md'))?.label).toBe(
      'Markdown or text file',
    )
  })

  it('refuses bytes no format recognises', () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0, 1])
    expect(loaderForBytes(binary)).toBeNull()
    // A zip that is not a Word document.
    expect(
      loaderForBytes(Buffer.from('PK\u0003\u0004 some other zip\u0000')),
    ).toBeNull()
  })

  it('treats an unknown stored type as PDF, as every older document is', () => {
    expect(loaderForMimeType('application/pdf').unit).toBe('page')
    expect(loaderForMimeType(null).unit).toBe('page')
    expect(loaderForMimeType('text/markdown').unit).toBe('section')
  })

  it('keeps the file picker in step with the loaders', () => {
    expect(DOCUMENT_ACCEPT.split(',').sort()).toEqual(
      [...DOCUMENT_EXTENSIONS].sort(),
    )
    expect(new Set(documentLoaders.map((l) => l.mimeType)).size).toBe(4)
  })
})

describe('Markdown (FR3)', () => {
  it('starts a section at each heading up to ###, and keeps tables and code whole', () => {
    const sections = markdownSections(
      '# Title\nintro\n\n## A\n- one\n- two\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n#### deep\nstill A\n\n## B\n```\ncode\nline\n```\n',
    )
    expect(sections).toHaveLength(3)
    expect(sections[1]).toEqual([
      { type: 'Section-header', text: 'A' },
      { type: 'List-item', text: 'one' },
      { type: 'List-item', text: 'two' },
      { type: 'Table', text: '| x | y |\n| 1 | 2 |' },
      { type: 'Section-header', text: 'deep' },
      { type: 'Text', text: 'still A' },
    ])
    expect(sections[2]).toContainEqual({ type: 'Table', text: 'code\nline' })
  })

  it('makes plain text one section', () => {
    expect(markdownSections('just words\non two lines')).toEqual([
      [{ type: 'Text', text: 'just words on two lines' }],
    ])
  })
})

describe('HTML (FR4)', () => {
  it('drops script, style, nav and footer, and sections at headings', () => {
    const sections = htmlSections(fixture('leave-policy.html').toString())
    const text = JSON.stringify(sections)
    expect(text).not.toContain('INJECTED SCRIPT TEXT')
    expect(text).not.toContain('navigation')
    expect(text).not.toContain('Copyright footer')
    expect(text).not.toContain('font:14px')
    expect(sections.map((s) => s[0])).toEqual([
      { type: 'Section-header', text: 'Leave policy' },
      { type: 'Section-header', text: 'Annual leave' },
      { type: 'Section-header', text: 'Parental leave' },
    ])
    expect(sections[2]).toContainEqual({
      type: 'Table',
      text: 'Type | Weeks\nPrimary carer | 18',
    })
  })
})

describe('turning a document into chunks', () => {
  it.each([['leave-policy.md'], ['leave-policy.html'], ['leave-policy.docx']])(
    '%s: sections become numbered pages, with no boxes',
    async (name) => {
      const bytes = fixture(name)
      const loader = loaderForBytes(bytes)!
      const { chunks, pageCount } = await loader.toChunks(bytes, options)
      expect(pageCount).toBe(3)
      expect(chunks.map((c) => c.pageNumber)).toEqual(
        [...chunks.map((c) => c.pageNumber)].sort((a, b) => a - b),
      )
      const annual = chunks.find((c) => c.content.includes('25 working days'))
      expect(annual?.pageNumber).toBe(2)
      expect(annual?.heading).toBe('Annual leave')
      for (const c of chunks) {
        expect(c.bbox).toBeUndefined()
        expect(c.boxes).toBeUndefined()
      }
      expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i))
    },
  )
})
