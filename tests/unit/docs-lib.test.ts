import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DOC_ORDER,
  docSummary,
  docTitle,
  headingText,
  headings,
  markdownLinks,
  resolveDocHref,
  stripBackLinks,
  unmappedDocs,
} from '../../scripts/docs-lib.mjs'

/** Spec 0041 — the rules shared by the in-app docs and `pnpm docs:check`. */

describe('resolveDocHref', () => {
  it('keeps doc links inside the app, with their anchor', () => {
    expect(resolveDocHref('rag.md#setup')).toEqual({
      kind: 'doc',
      slug: 'rag',
      href: '/docs/rag#setup',
    })
    expect(resolveDocHref('./usage.md').href).toBe('/docs/usage')
  })

  it('leaves same-page anchors and absolute URLs alone', () => {
    expect(resolveDocHref('#tier-b')).toEqual({
      kind: 'anchor',
      href: '#tier-b',
    })
    expect(resolveDocHref('https://nvidia.com').kind).toBe('external')
    expect(resolveDocHref('mailto:x@y.z').kind).toBe('external')
  })

  it('serves images from /docs-assets', () => {
    expect(resolveDocHref('images/answer.png')).toEqual({
      kind: 'image',
      href: '/docs-assets/answer.png',
    })
  })

  it('sends links that leave docs/ to GitHub at the given ref', () => {
    expect(resolveDocHref('../README.md', 'abc123')).toMatchObject({
      kind: 'repo',
      path: 'README.md',
      href: 'https://github.com/devdaviddr/nextjs-rag-boilerplate/blob/abc123/README.md',
    })
    expect(resolveDocHref('../specs/').href).toContain('/tree/main/specs')
    expect(resolveDocHref('../src/lib/env.ts#L10').href).toMatch(
      /\/blob\/main\/src\/lib\/env\.ts#L10$/,
    )
  })
})

describe('headings', () => {
  it('produces the ids rehype-slug gives the rendered headings', () => {
    const md = [
      '# Title',
      '## Why `chunks` repeats `owner_id` and `knowledge_base_id`',
      '## Tier B (recommended) — pull with `make deploy`',
      '## Setup',
      '## Setup',
      '```',
      '## not a heading',
      '```',
    ].join('\n')
    expect(headings(md).map((h) => h.id)).toEqual([
      'title',
      'why-chunks-repeats-owner_id-and-knowledge_base_id',
      'tier-b-recommended--pull-with-make-deploy',
      'setup',
      'setup-1',
    ])
  })

  it('treats code spans as literal and intraword underscores as text', () => {
    expect(headingText('**Bold** and _italic_ and snake_case `a_b_c`')).toBe(
      'Bold and italic and snake_case a_b_c',
    )
  })
})

describe('titles, summaries and back links', () => {
  const md = [
    '# Database',
    '',
    '[← Back to README](../README.md)',
    '',
    '**What this covers:** the tables, the [ERD](#erd) and `migrations`.',
    '',
    'Body.',
  ].join('\n')

  it('reads the title and the What-this-covers line', () => {
    expect(docTitle(md, 'database')).toBe('Database')
    expect(docSummary(md)).toBe('the tables, the ERD and migrations.')
  })

  it('falls back to the first paragraph', () => {
    expect(
      docSummary('# T\n\n> note\n\nFirst real *paragraph*.\n\nNext.'),
    ).toBe('First real paragraph.')
  })

  it('drops the Back-to-README line', () => {
    expect(stripBackLinks(md)).not.toContain('Back to README')
  })
})

describe('markdownLinks', () => {
  it('finds links and images in prose, not in code', () => {
    const md =
      'See [a](a.md) and ![img](images/x.png).\n`[no](b.md)`\n```\n[no](c.md)\n```'
    expect(markdownLinks(md).map((l) => l.href)).toEqual([
      'a.md',
      'images/x.png',
    ])
  })
})

describe('the index', () => {
  it('maps every docs/*.md exactly once', () => {
    const onDisk = readdirSync(join(process.cwd(), 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
    expect(unmappedDocs(onDisk)).toEqual({
      missingFromIndex: [],
      missingOnDisk: [],
    })
    expect(new Set(DOC_ORDER).size).toBe(DOC_ORDER.length)
  })
})
