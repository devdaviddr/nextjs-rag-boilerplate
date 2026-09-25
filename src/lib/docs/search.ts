/**
 * Searching the docs in the browser (spec 0041 FR7). The index is built on
 * the server from docs/*.md (`searchIndex` in ./index.ts) and fetched once;
 * everything here is pure, so it runs in the client and in unit tests alike.
 */

/** One heading's worth of a page, or the page's introduction (`id: ''`). */
export interface SearchEntry {
  slug: string
  title: string
  section: string
  id: string
  heading: string
  text: string
}

export interface SearchResult {
  entry: SearchEntry
  href: string
  /** A short window of the text around the first match, or its opening. */
  snippet: string
  score: number
}

export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
}

function occurrences(hay: string, term: string): number {
  let n = 0
  for (
    let i = hay.indexOf(term);
    i !== -1 && n < 5;
    i = hay.indexOf(term, i + term.length)
  )
    n++
  return n
}

function snippet(text: string, terms: string[], width = 160): string {
  const lower = text.toLowerCase()
  const at = Math.min(
    ...terms.map((t) => lower.indexOf(t)).filter((i) => i !== -1),
  )
  if (!Number.isFinite(at) || at < width / 2) {
    return text.length > width ? `${text.slice(0, width).trimEnd()}…` : text
  }
  const start = text.lastIndexOf(' ', at - width / 3) + 1
  const body = text.slice(start, start + width).trimEnd()
  return `…${body}${start + width < text.length ? '…' : ''}`
}

/**
 * Entries containing every term, best first. A match in a heading outranks
 * one in the page title, which outranks one in the text; at most
 * `perPage` results come from any one page, so a single long page cannot
 * crowd the rest out.
 */
export function searchDocs(
  entries: readonly SearchEntry[],
  query: string,
  { limit = 8, perPage = 3 }: { limit?: number; perPage?: number } = {},
): SearchResult[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  const scored: SearchResult[] = []
  for (const entry of entries) {
    const heading = entry.heading.toLowerCase()
    const title = entry.title.toLowerCase()
    const text = entry.text.toLowerCase()
    let score = 0
    let all = true
    for (const term of terms) {
      const s =
        (heading.includes(term) ? 10 : 0) +
        (title.includes(term) ? 6 : 0) +
        occurrences(text, term)
      if (s === 0) {
        all = false
        break
      }
      score += s + (heading.startsWith(term) ? 2 : 0)
    }
    if (!all) continue
    scored.push({
      entry,
      href: `/docs/${entry.slug}${entry.id ? `#${entry.id}` : ''}`,
      snippet: snippet(entry.text, terms),
      score,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  const perSlug = new Map<string, number>()
  const out: SearchResult[] = []
  for (const r of scored) {
    const n = perSlug.get(r.entry.slug) ?? 0
    if (n >= perPage) continue
    perSlug.set(r.entry.slug, n + 1)
    out.push(r)
    if (out.length === limit) break
  }
  return out
}

/** `text` cut into plain and matching parts, for highlighting. */
export function highlight(
  text: string,
  terms: string[],
): { text: string; match: boolean }[] {
  if (terms.length === 0) return [{ text, match: false }]
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  // split() with one capture group puts the matches at the odd indices.
  return text
    .split(re)
    .map((part, i) => ({ text: part, match: i % 2 === 1 }))
    .filter((p) => p.text)
}
