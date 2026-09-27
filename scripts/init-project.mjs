#!/usr/bin/env node
// Rename a project started from this template, in one command (#151).
//
//   pnpm init:project                       # asks for each value
//   pnpm init:project --name "Acme Docs" --repo https://github.com/acme/docs \
//     [--short-name "Acme"] [--description "…"] [--theme "#1e293b"]
//
// Every edit is an anchored replacement on one known line, never a find and
// replace across the tree. That is deliberate: the settings encryption salt in
// src/lib/ai-settings/crypto.ts looks like the project's name and must never
// change (docs/forking.md). Safe to re-run; a second run with the same values
// changes nothing. Fails without writing anything if a file no longer looks
// the way it expects.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function flag(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/**
 * A string literal the way Prettier writes one: single quotes, unless the
 * value contains a single quote and no double one.
 */
const tsString = (v) =>
  v.includes("'") && !v.includes('"')
    ? JSON.stringify(v)
    : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** A whole string literal, either quote, escapes included. */
const LITERAL = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`

async function ask(rl, question, fallback) {
  if (!rl) return fallback
  const answer = (
    await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)
  ).trim()
  return answer || fallback
}

const brandPath = join(root, 'src/lib/brand.ts')
const brand = readFileSync(brandPath, 'utf8')
const current = (name) => {
  const literal = brand.match(
    new RegExp(String.raw`export const ${name} =\s*(${LITERAL})`),
  )?.[1]
  // Both quote styles are valid JS string literals once single quotes are
  // swapped for double ones; JSON.parse then undoes the escapes.
  return literal?.startsWith('"')
    ? JSON.parse(literal)
    : literal?.slice(1, -1).replace(/\\(.)/g, '$1')
}

const interactive = process.stdin.isTTY && !flag('name')
const rl = interactive
  ? createInterface({ input: process.stdin, output: process.stdout })
  : null

const name =
  flag('name') ?? (await ask(rl, 'Project name', current('APP_NAME')))
const shortName =
  flag('short-name') ?? (await ask(rl, 'Short name (PWA, tab titles)', name))
const description =
  flag('description') ??
  (await ask(rl, 'One-line description', current('APP_DESCRIPTION')))
const repo =
  flag('repo') ??
  (await ask(rl, 'Repository URL (https://github.com/owner/repo)', undefined))
const theme =
  flag('theme') ?? (await ask(rl, 'Theme colour (#rrggbb, blank to keep)', ''))
rl?.close()

const problems = []
if (!name) problems.push('a project name is required')
if (!repo || !/^https:\/\/\S+\/\S+$/.test(repo))
  problems.push('--repo must be a URL like https://github.com/owner/repo')
if (theme && !/^#[0-9a-fA-F]{6}$/.test(theme))
  problems.push('--theme must be a colour like #1e293b')
if (problems.length) {
  console.error(`init-project: ${problems.join('; ')}`)
  process.exit(1)
}

const packageName = name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')

/** [file, pattern, replacement] — each pattern must match exactly once. */
const edits = [
  [
    'src/lib/brand.ts',
    new RegExp(String.raw`export const APP_NAME = ${LITERAL}`),
    `export const APP_NAME = ${tsString(name)}`,
  ],
  [
    'src/lib/brand.ts',
    new RegExp(String.raw`export const APP_SHORT_NAME = ${LITERAL}`),
    `export const APP_SHORT_NAME = ${tsString(shortName)}`,
  ],
  [
    'src/lib/brand.ts',
    new RegExp(String.raw`export const APP_DESCRIPTION =\s*${LITERAL}`),
    `export const APP_DESCRIPTION =\n  ${tsString(description)}`,
  ],
  ['package.json', /"name": "[^"]*"/, `"name": ${JSON.stringify(packageName)}`],
  [
    'scripts/docs-lib.mjs',
    /export const REPO_URL = '[^']*'/,
    `export const REPO_URL = ${tsString(repo.replace(/\.git$|\/$/g, ''))}`,
  ],
]
if (theme) {
  edits.push(
    [
      'src/app/manifest.ts',
      /theme_color: '#[0-9a-fA-F]{6}'/,
      `theme_color: '${theme}'`,
    ],
    [
      'src/app/layout.tsx',
      /(prefers-color-scheme: dark\)', color: )'#[0-9a-fA-F]{6}'/,
      `$1'${theme}'`,
    ],
    [
      'scripts/generate-icons.mjs',
      /const THEME = '#[0-9a-fA-F]{6}'/,
      `const THEME = '${theme}'`,
    ],
    [
      'scripts/generate-og-image.mjs',
      /const THEME = '#[0-9a-fA-F]{6}'/,
      `const THEME = '${theme}'`,
    ],
  )
}

// Check every edit before writing any, so a failure leaves the tree untouched.
const files = new Map()
for (const [file, pattern] of edits) {
  const text = files.get(file) ?? readFileSync(join(root, file), 'utf8')
  files.set(file, text)
  const matches = text.match(new RegExp(pattern.source, 'g')) ?? []
  if (matches.length !== 1) {
    console.error(
      `init-project: expected one match for ${pattern} in ${file}, found ${matches.length}. Nothing was changed.`,
    )
    process.exit(1)
  }
}
for (const [file, pattern, replacement] of edits) {
  files.set(file, files.get(file).replace(pattern, replacement))
}
for (const [file, text] of files) writeFileSync(join(root, file), text)
// Leave the edited files as the repository's formatter would, so CI's
// format check passes straight after a rename.
try {
  execFileSync(
    join(root, 'node_modules/.bin/prettier'),
    ['--write', ...files.keys()],
    { cwd: root, stdio: 'ignore' },
  )
} catch {
  console.warn('Prettier did not run; run `pnpm format` before committing.')
}
console.log(`✓ renamed to "${name}" (${packageName}), repository ${repo}`)

// The icons only change with the theme; the share image carries the name.
const run = (script) =>
  execFileSync(process.execPath, [join(root, 'scripts', script)], {
    stdio: 'inherit',
    cwd: root,
  })
if (theme) run('generate-icons.mjs')
run('generate-og-image.mjs')

console.log(`
Left for you (docs/forking.md walks through each):
  - Colours beyond the theme: src/app/globals.css tokens, background_color in
    src/app/manifest.ts, and the light themeColor in src/app/layout.tsx.
  - The README, and CLAUDE.md's project-specific sections.
  - The upstream maintainer's workflow files you don't want.
  - Leave the SALT in src/lib/ai-settings/crypto.ts exactly as it is.
Then: pnpm lint && pnpm typecheck && pnpm test && pnpm build`)
