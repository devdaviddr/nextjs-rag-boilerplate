import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  docTitle,
  headings,
  searchEntries,
  stripTitle,
} from '../../scripts/docs-lib.mjs'
import {
  type SearchEntry,
  highlight,
  searchDocs,
  searchTerms,
} from '@/lib/docs/search'

/** Spec 0041 FR7 — searching the docs in the browser. */

const DOC = `# Guide

[← Back to README](../README.md)

**What this covers:** setting up \`RAG_TOP_K\` and [retrieval](rag.md).

## Install

Run the *installer*.

\`\`\`bash
# not a heading
secret-in-code
\`\`\`

### Options <small>(advanced)</small>

| Name | Default |
| ---- | ------- |
| owner_id | none |

## Install

Again, a <=> b.
`

describe('searchEntries', () => {
  const entries = searchEntries(DOC)

  it('cuts a page at its headings, with the ids the page uses', () => {
    expect(entries.map((e) => e.id)).toEqual([
      '',
      'install',
      'options-advanced',
      'install-1',
    ])
    const ids = headings(DOC)
      .filter((h) => h.depth > 1)
      .map((h) => h.id)
    expect(entries.slice(1).map((e) => e.id)).toEqual(ids)
  })

  it('keeps the words and drops the markup, the back link and fenced code', () => {
    expect(entries[0]?.text).toBe(
      'What this covers: setting up RAG_TOP_K and retrieval.',
    )
    expect(entries[1]?.text).toBe('Run the installer.')
    expect(entries[2]?.text).toContain('owner_id')
    expect(entries[2]?.text).not.toContain('|')
    expect(entries[3]?.text).toBe('Again, a <=> b.')
    expect(JSON.stringify(entries)).not.toContain('secret-in-code')
  })
})

describe('stripTitle', () => {
  it('removes a leading # title and nothing else', () => {
    expect(stripTitle('# Title\n\nBody\n# Later')).toBe('Body\n# Later')
    expect(stripTitle('Body\n\n# Not first')).toBe('Body\n\n# Not first')
  })
})

const entry = (e: Partial<SearchEntry>): SearchEntry => ({
  slug: 'a',
  title: 'A',
  section: 'S',
  id: '',
  heading: '',
  text: '',
  ...e,
})

describe('searchDocs', () => {
  it('needs every term, and ranks a heading match first', () => {
    const entries = [
      entry({ slug: 'a', id: 'x', heading: 'Other', text: 'backup restore' }),
      entry({ slug: 'b', id: 'y', heading: 'Restore a backup', text: '' }),
      entry({ slug: 'c', id: 'z', heading: 'Backup', text: 'nothing else' }),
    ]
    const results = searchDocs(entries, 'Backup  RESTORE')
    expect(results.map((r) => r.href)).toEqual(['/docs/b#y', '/docs/a#x'])
  })

  it('links an introduction to the page itself', () => {
    const [hit] = searchDocs([entry({ slug: 'rag', text: 'hybrid' })], 'hybrid')
    expect(hit?.href).toBe('/docs/rag')
  })

  it('caps results per page and overall', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      entry({ slug: `p${i % 2}`, id: `h${i}`, text: 'match' }),
    )
    expect(searchDocs(many, 'match')).toHaveLength(6)
    expect(searchDocs(many, 'match', { limit: 4 })).toHaveLength(4)
    expect(searchDocs(many, '   ')).toEqual([])
  })

  it('shows the text around the first match', () => {
    const text = `${'word '.repeat(60)}needle ${'tail '.repeat(40)}`
    const [hit] = searchDocs([entry({ id: 'h', text })], 'needle')
    expect(hit?.snippet.startsWith('…')).toBe(true)
    expect(hit?.snippet).toContain('needle')
    expect(hit?.snippet.length).toBeLessThanOrEqual(163)
  })
})

describe('highlight', () => {
  it('marks every match, case-insensitively, and treats terms literally', () => {
    expect(highlight('Use halfvec(2048), HALFVEC.', ['halfvec'])).toEqual([
      { text: 'Use ', match: false },
      { text: 'halfvec', match: true },
      { text: '(2048), ', match: false },
      { text: 'HALFVEC', match: true },
      { text: '.', match: false },
    ])
    expect(highlight('a (b)', ['(b)'])).toEqual([
      { text: 'a ', match: false },
      { text: '(b)', match: true },
    ])
    expect(searchTerms(' A a b ')).toEqual(['a', 'b'])
  })
})

describe('the real docs', () => {
  const load = (slug: string): SearchEntry[] => {
    const md = readFileSync(join(process.cwd(), 'docs', `${slug}.md`), 'utf8')
    const title = docTitle(md, slug)
    return searchEntries(md).map((e) => ({ ...e, slug, title, section: '' }))
  }

  it('FR7: "halfvec" finds the Database and RAG pages at the right headings', () => {
    const hrefs = searchDocs(
      [...load('database'), ...load('rag'), ...load('email')],
      'halfvec',
    ).map((r) => r.href)
    expect(hrefs).toContain('/docs/database#what-pgvector-adds')
    expect(hrefs).toContain('/docs/rag#why-halfvec2048-and-not-vector2048')
    expect(hrefs.some((h) => h.startsWith('/docs/email'))).toBe(false)
  })
})
