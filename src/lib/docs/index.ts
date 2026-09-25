import 'server-only'

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  DOC_ORDER,
  DOC_SECTIONS,
  docSummary,
  docTitle,
  headings,
  searchEntries,
  stripBackLinks,
  stripTitle,
} from '../../../scripts/docs-lib.mjs'
import type { SearchEntry } from './search'

/**
 * The repo's docs/*.md, loaded for the in-app Docs section (spec 0041).
 *
 * Read once per server process and kept in memory. The pages cannot be fully
 * static — the dashboard layout reads the session on every request — so the
 * files ship in the image instead (next.config.ts traces `docs/`), and the
 * first request pays one read of ~250 KB.
 *
 * `turbopackIgnore`: without it the standalone tracer cannot tell what a
 * cwd-relative path points at and copies the whole project into the build
 * (the #16 lesson). The directory is included explicitly instead.
 */
const DOCS_DIR = join(/* turbopackIgnore: true */ process.cwd(), 'docs')

export interface DocHeading {
  depth: number
  text: string
  id: string
}

export interface Doc {
  slug: string
  title: string
  summary: string
  section: string
  /** The markdown to render: no back link, no `# ` title (the page header shows it). */
  body: string
  headings: DocHeading[]
  search: SearchEntry[]
}

let cache: Map<string, Doc> | null = null

function load(): Map<string, Doc> {
  if (cache && process.env.NODE_ENV === 'production') return cache
  const sectionOf = new Map(
    DOC_SECTIONS.flatMap((s) => s.slugs.map((slug) => [slug, s.title])),
  )
  const docs = new Map<string, Doc>()
  for (const file of readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'))) {
    const slug = file.slice(0, -3)
    const raw = readFileSync(join(DOCS_DIR, file), 'utf8')
    const title = docTitle(raw, slug)
    const section = sectionOf.get(slug) ?? 'Other'
    docs.set(slug, {
      slug,
      title,
      summary: docSummary(raw),
      section,
      body: stripTitle(stripBackLinks(raw)),
      headings: headings(raw),
      search: searchEntries(raw).map((e) => ({
        slug,
        title,
        section,
        id: e.id,
        heading: e.heading,
        text: e.text,
      })),
    })
  }
  cache = docs
  return docs
}

export function getDoc(slug: string): Doc | null {
  return load().get(slug) ?? null
}

/** The index: sections in reading order, each with its docs. */
export function docSections(): {
  title: string
  description: string
  docs: Doc[]
}[] {
  const docs = load()
  return DOC_SECTIONS.map((s) => ({
    title: s.title,
    description: s.description,
    docs: s.slugs.map((slug) => docs.get(slug)).filter((d): d is Doc => !!d),
  })).filter((s) => s.docs.length > 0)
}

/** Previous and next pages in reading order. */
export function neighbours(slug: string): {
  prev: Doc | null
  next: Doc | null
} {
  const docs = load()
  const i = DOC_ORDER.indexOf(slug)
  const at = (j: number) =>
    j >= 0 ? (docs.get(DOC_ORDER[j] ?? '') ?? null) : null
  return { prev: i > 0 ? at(i - 1) : null, next: i >= 0 ? at(i + 1) : null }
}

/** Every page's search entries, in reading order (spec 0041 FR7). */
export function searchIndex(): SearchEntry[] {
  const docs = load()
  return DOC_ORDER.flatMap((slug) => docs.get(slug)?.search ?? [])
}
