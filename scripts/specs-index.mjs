// Generates the spec index table in specs/README.md from each spec's own
// frontmatter, so status and release live in exactly one place.
//
//   pnpm specs:index    rewrite the table
//   pnpm specs:check    verify the table is current and the frontmatter is
//                       well-formed — exits non-zero if not
//
// Before this existed, status was recorded twice (frontmatter + the index) and
// the two drifted: 0025-0027 read "Shipped / v0.20.0" in their frontmatter
// while the index still said "In Progress", and 0028-0029 were missing from
// the index entirely. Generating the table removes the second source of truth.
//
// --check compares the table SEMANTICALLY (parsed rows), not as text, so
// Prettier's column padding can never cause a spurious failure.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const SPECS_DIR = join(root, 'specs')
const INDEX_FILE = join(SPECS_DIR, 'README.md')
const START = '<!-- specs:index:start -->'
const END = '<!-- specs:index:end -->'

// Kept in step with the lifecycle in specs/README.md. Proposed and Shipped are
// the states in active use; Superseded and Rejected exist so a spec that stops
// being the plan of record still has an honest status.
const ALLOWED_STATUS = ['Proposed', 'Shipped', 'Superseded', 'Rejected']

const check = process.argv.includes('--check')
const problems = []
const warnings = []

/**
 * Reads the `---` frontmatter block at the top of a markdown file into a plain
 * object. Deliberately not a YAML parser: the frontmatter here is flat
 * key/value pairs, and adding a dependency to read four fields is not a trade
 * worth making. Strips surrounding quotes and any trailing `# comment`.
 */
function readFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0].trim() !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end === -1) return null

  const out = {}
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!match) continue
    const [, key] = match
    let value = match[2].trim()
    // A trailing comment, but only outside quotes — `release: '—' # note`.
    const quoted = value.match(/^(['"])(.*?)\1/)
    if (quoted) {
      value = quoted[2]
    } else {
      const hash = value.indexOf(' #')
      if (hash !== -1) {
        out[`${key}__comment`] = value.slice(hash + 2).trim()
        value = value.slice(0, hash).trim()
      }
    }
    out[key] = value
  }
  return out
}

function specFiles() {
  return readdirSync(SPECS_DIR)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort()
}

function loadSpecs() {
  return specFiles().map((file) => {
    const path = join(SPECS_DIR, file)
    const text = readFileSync(path, 'utf8')
    const fm = readFrontmatter(text)

    if (!fm) {
      problems.push(`${file}: no frontmatter block`)
      return {
        file,
        id: file.slice(0, 4),
        title: file,
        status: '?',
        release: '—',
      }
    }

    const idFromName = file.slice(0, 4)
    const id = String(fm.id ?? '').padStart(4, '0')
    const status = fm.status ?? ''
    const release = fm.release ?? '—'

    if (id !== idFromName) {
      problems.push(
        `${file}: frontmatter id "${fm.id}" does not match the filename`,
      )
    }
    if (!ALLOWED_STATUS.includes(status)) {
      problems.push(
        `${file}: status "${status}" is not one of ${ALLOWED_STATUS.join(', ')}`,
      )
    }
    // The template ships its status line with the legal values as a trailing
    // comment. Five specs kept it after being filled in; it is residue, not
    // information, and it belongs only in TEMPLATE.md.
    if (fm.status__comment) {
      problems.push(
        `${file}: template residue on the status line — remove "# ${fm.status__comment}"`,
      )
    }
    if (status === 'Shipped' && (!release || release === '—')) {
      problems.push(`${file}: status is Shipped but release is empty`)
    }
    if (!fm.title) problems.push(`${file}: no title`)

    // The check that would have caught the decay this script was written for:
    // seven specs shipped with 43 acceptance criteria left unticked, three of
    // them with every box open.
    //
    // A criterion can legitimately stay open — it needed a Cloudflare domain
    // nobody had, or it described CI that was later deleted. What is not
    // legitimate is an open box with no explanation. So the warning fires only
    // when a Shipped spec has unticked boxes AND no note accounting for them;
    // adding the note is the act of taking responsibility for the gap.
    if (status === 'Shipped') {
      const unticked = (text.match(/^- \[ \]/gm) ?? []).length
      const accounted = /^> \*\*(Not verified|No longer verifiable)/m.test(text)
      if (unticked > 0 && !accounted) {
        warnings.push(
          `${file}: Shipped with ${unticked} unticked acceptance criteri${unticked === 1 ? 'on' : 'a'} and no note explaining why`,
        )
      }
    }

    return { file, id: idFromName, title: fm.title ?? file, status, release }
  })
}

function buildTable(specs) {
  const header = ['Spec', 'Title', 'Status', 'Release']
  const rows = specs.map((s) => [
    `[${s.id}](${s.file})`,
    s.title,
    s.status,
    s.release,
  ])

  // Pad to the widest cell per column so the emitted table is already in the
  // shape Prettier would format it into, and `pnpm specs:index` never leaves
  // the file needing a format pass.
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  )
  const line = (cells) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`

  return [
    line(header),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n')
}

/** Parses a markdown table back into trimmed cell rows, ignoring padding. */
function parseTable(markdown) {
  return markdown
    .trim()
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .filter((l) => !/^\|[\s|:-]+\|$/.test(l.trim()))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    )
}

const specs = loadSpecs()
const table = buildTable(specs)

const readme = readFileSync(INDEX_FILE, 'utf8')
const startAt = readme.indexOf(START)
const endAt = readme.indexOf(END)

if (startAt === -1 || endAt === -1) {
  console.error(
    `specs-index: ${INDEX_FILE} is missing the ${START} / ${END} markers.`,
  )
  process.exit(1)
}

const current = readme.slice(startAt + START.length, endAt)
const updated =
  readme.slice(0, startAt + START.length) +
  `\n\n${table}\n\n` +
  readme.slice(endAt)

if (check) {
  const stale =
    JSON.stringify(parseTable(current)) !== JSON.stringify(parseTable(table))
  if (stale) {
    problems.push(
      'specs/README.md index is out of date — run `pnpm specs:index`',
    )
  }
  for (const w of warnings) console.warn(`warning  ${w}`)
  if (problems.length > 0) {
    for (const p of problems) console.error(`error    ${p}`)
    console.error(
      `\nspecs:check failed with ${problems.length} problem${problems.length === 1 ? '' : 's'}.`,
    )
    process.exit(1)
  }
  console.log(
    `specs:check passed — ${specs.length} specs, index current` +
      (warnings.length > 0 ? `, ${warnings.length} warning(s)` : ''),
  )
} else {
  for (const w of warnings) console.warn(`warning  ${w}`)
  if (problems.length > 0) {
    for (const p of problems) console.error(`error    ${p}`)
    console.error('\nFix the frontmatter above, then re-run.')
    process.exit(1)
  }
  writeFileSync(INDEX_FILE, updated)
  console.log(`specs-index: wrote ${specs.length} rows to specs/README.md`)
}
