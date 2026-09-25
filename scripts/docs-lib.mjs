// The in-app documentation's rules, shared by the app (src/lib/docs) and the
// link checker (scripts/docs-check.mjs) so the two can never disagree about
// where a link goes or what an anchor is called. Pure functions only — no
// file system — so they are unit-tested in tests/unit/docs-lib.test.ts.
//
// Spec 0041. The content itself stays in docs/*.md, unchanged: the app adapts
// to the docs as they read on GitHub, never the reverse (NFR3).
import GithubSlugger from 'github-slugger'

/** Where links that leave docs/ are sent (README, specs, source files). */
export const REPO_URL = 'https://github.com/devdaviddr/nextjs-rag-boilerplate'

/**
 * The index, in reading order (FR1). Every docs/*.md must appear exactly once;
 * `unmappedDocs` and the docs check fail otherwise, so a new doc cannot
 * silently go missing from the app.
 */
export const DOC_SECTIONS = [
  { title: 'About', slugs: ['summary'] },
  { title: 'Using the app', slugs: ['tutorial', 'usage'] },
  { title: 'Features', slugs: ['features', 'pwa', 'push', 'email', 'oauth'] },
  { title: 'Architecture & retrieval', slugs: ['architecture', 'rag'] },
  { title: 'Data', slugs: ['database', 'backups'] },
  {
    title: 'Operations',
    slugs: ['self-hosting', 'deployment', 'ci-cd', 'workflow'],
  },
]

/** Slugs in reading order, for previous / next links. */
export const DOC_ORDER = DOC_SECTIONS.flatMap((s) => s.slugs)

/** Docs present on disk but missing from DOC_SECTIONS, and the reverse. */
export function unmappedDocs(slugsOnDisk) {
  const mapped = new Set(DOC_ORDER)
  const onDisk = new Set(slugsOnDisk)
  return {
    missingFromIndex: slugsOnDisk.filter((s) => !mapped.has(s)).sort(),
    missingOnDisk: DOC_ORDER.filter((s) => !onDisk.has(s)),
  }
}

/** Lines of `markdown` outside fenced code blocks, with their line numbers. */
function proseLines(markdown) {
  const out = []
  let fence = null
  markdown.split('\n').forEach((line, i) => {
    const m = /^\s*(```+|~~~+)/.exec(line)
    if (m) {
      if (!fence) fence = m[1][0]
      else if (m[1][0] === fence) fence = null
      return
    }
    if (!fence) out.push({ line, number: i + 1 })
  })
  return out
}

/**
 * Plain text of a heading as a rendered HTML heading would contain it — what
 * rehype-slug feeds github-slugger — so anchors computed here match the ids
 * on the page.
 */
export function headingText(raw) {
  // Code spans are literal: lift them out before touching emphasis, so the
  // underscores in `owner_id` are not read as italics.
  const code = []
  const withoutCode = raw.replace(/`([^`]*)`/g, (_, c) => {
    code.push(c)
    return `\u0000${code.length - 1}\u0000`
  })
  return (
    withoutCode
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      // Underscore emphasis only at word edges: intraword _ is literal.
      .replace(/(^|[^\w])__(.+?)__(?=[^\w]|$)/g, '$1$2')
      .replace(/(^|[^\w])_(.+?)_(?=[^\w]|$)/g, '$1$2')
      .replace(/<[^>]+>/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
      .replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)])
      .trim()
  )
}

/** Every ATX heading with the id rehype-slug gives it, in document order. */
export function headings(markdown) {
  const slugger = new GithubSlugger()
  const out = []
  for (const { line } of proseLines(markdown)) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const text = headingText(m[2])
    out.push({ depth: m[1].length, text, id: slugger.slug(text) })
  }
  return out
}

/** The first `# ` heading, or the slug. */
export function docTitle(markdown, slug) {
  return headings(markdown).find((h) => h.depth === 1)?.text ?? slug
}

/**
 * One line describing the page for the index: the **What this covers:** line
 * where the doc has one, otherwise its first real paragraph.
 */
export function docSummary(markdown) {
  const lines = proseLines(markdown).map((l) => l.line)
  const text = (from) => {
    const buf = []
    for (let i = from; i < lines.length; i++) {
      const l = lines[i].trim()
      if (!l) break
      buf.push(l)
    }
    return buf
      .join(' ')
      .replace(/\*\*What this covers:\*\*\s*/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim()
  }
  const covers = lines.findIndex((l) => l.startsWith('**What this covers:**'))
  if (covers !== -1) return text(covers)
  const first = lines.findIndex(
    (l) =>
      l.trim() &&
      !l.startsWith('#') &&
      !l.startsWith('[←') &&
      !l.startsWith('>') &&
      !l.startsWith('|') &&
      !l.startsWith('<') &&
      !/^[-*]\s/.test(l.trim()) &&
      !/^---+$/.test(l.trim()),
  )
  return first === -1 ? '' : text(first)
}

/** Drop the "[← Back to README](../README.md)" lines; the app has its own index. */
export function stripBackLinks(markdown) {
  return markdown.replace(/^\[← Back to [^\]]*\]\([^)]*\)\s*\n+/gm, '')
}

/** Normalise `a/../b/./c` segments. */
function normalise(path) {
  const out = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/**
 * Where a link in docs/<slug>.md goes inside the app (FR3):
 *
 * - `x.md#frag`      → `/docs/x#frag`
 * - `#frag`          → the same page
 * - `images/a.png`   → `/docs-assets/a.png`
 * - anything else relative (README, specs/, source) → GitHub at `ref`
 * - absolute URLs    → unchanged
 */
export function resolveDocHref(href, ref = 'main') {
  if (!href) return { kind: 'external', href: '' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
    return { kind: 'external', href }
  }
  if (href.startsWith('#')) return { kind: 'anchor', href }
  const [pathPart, fragment] = href.split('#', 2)
  const hash = fragment ? `#${fragment}` : ''
  const target = normalise(`docs/${pathPart}`)
  const doc = /^docs\/([a-z0-9-]+)\.md$/i.exec(target)
  if (doc) return { kind: 'doc', slug: doc[1], href: `/docs/${doc[1]}${hash}` }
  const image = /^docs\/images\/([^/]+)$/.exec(target)
  if (image) return { kind: 'image', href: `/docs-assets/${image[1]}` }
  const view =
    pathPart.endsWith('/') || !/\.[a-z0-9]+$/i.test(target) ? 'tree' : 'blob'
  return {
    kind: 'repo',
    path: target,
    href: `${REPO_URL}/${view}/${ref}/${target}${hash}`,
  }
}

/**
 * Every link and image target in the prose of a doc, with its line — what
 * the docs check verifies. Inline code spans are ignored.
 */
export function markdownLinks(markdown) {
  const out = []
  for (const { line, number } of proseLines(markdown)) {
    const prose = line.replace(/`[^`]*`/g, '')
    for (const m of prose.matchAll(
      /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    )) {
      out.push({ href: m[1], line: number })
    }
  }
  return out
}
