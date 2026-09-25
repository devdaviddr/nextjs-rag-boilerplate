// Checks the in-app documentation (spec 0041 FR5): every docs/*.md is in the
// index, and every relative link and #anchor resolves — the same way the app
// resolves it, because both use scripts/docs-lib.mjs.
//
//   pnpm docs:check
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  headings,
  markdownLinks,
  resolveDocHref,
  unmappedDocs,
} from './docs-lib.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const docsDir = join(root, 'docs')
const slugs = readdirSync(docsDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .sort()
const text = Object.fromEntries(
  slugs.map((s) => [s, readFileSync(join(docsDir, `${s}.md`), 'utf8')]),
)
const ids = Object.fromEntries(
  slugs.map((s) => [s, new Set(headings(text[s]).map((h) => h.id))]),
)

const problems = []
const { missingFromIndex, missingOnDisk } = unmappedDocs(slugs)
for (const s of missingFromIndex)
  problems.push(`docs/${s}.md is not in DOC_SECTIONS (scripts/docs-lib.mjs)`)
for (const s of missingOnDisk)
  problems.push(`DOC_SECTIONS lists "${s}" but docs/${s}.md does not exist`)

let checked = 0
for (const slug of slugs) {
  for (const { href, line } of markdownLinks(text[slug])) {
    const where = `docs/${slug}.md:${line}`
    const r = resolveDocHref(href)
    checked++
    if (r.kind === 'external') continue
    if (r.kind === 'anchor') {
      const id = decodeURIComponent(href.slice(1))
      if (!ids[slug].has(id))
        problems.push(`${where}: no heading "#${id}" on this page`)
    } else if (r.kind === 'doc') {
      if (!text[r.slug]) {
        problems.push(`${where}: ${href} → docs/${r.slug}.md does not exist`)
        continue
      }
      const frag = href.split('#')[1]
      if (frag && !ids[r.slug].has(decodeURIComponent(frag))) {
        problems.push(
          `${where}: ${href} → no heading "#${frag}" in docs/${r.slug}.md`,
        )
      }
    } else if (r.kind === 'image') {
      const file = join(docsDir, 'images', r.href.split('/').pop())
      if (!existsSync(file))
        problems.push(`${where}: image ${href} does not exist`)
    } else if (r.kind === 'repo') {
      if (!existsSync(join(root, r.path)))
        problems.push(
          `${where}: ${href} → ${r.path} does not exist in the repo`,
        )
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`error    ${p}`)
  console.error(
    `\ndocs:check failed with ${problems.length} problem${problems.length === 1 ? '' : 's'}.`,
  )
  process.exit(1)
}
console.log(`docs:check passed — ${slugs.length} docs, ${checked} links`)
