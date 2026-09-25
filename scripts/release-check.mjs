// Checks that a release is consistent before (and when) it is tagged.
//
//   pnpm release:next                 suggest the next version from the
//                                     Conventional Commits since the last tag
//   pnpm release:check                check the version in package.json as the
//                                     release about to be tagged
//   pnpm release:check --tag v1.2.3   check a specific tag (ci.yml's release
//                                     job passes the tag it is running for)
//
// A release is consistent when package.json, the CHANGELOG heading and the tag
// all name the same version, [Unreleased] has been rolled into it, the version
// is higher than every earlier tag, and no finished spec is still Proposed.
// These are the steps that were missed on past releases; see
// docs/workflow.md § 5.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acceptanceCounts,
  changelogSection,
  compareVersions,
  isFinishedButProposed,
  nextVersion,
  parseVersion,
  sectionHasEntries,
} from './process-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const git = (...a) =>
  execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function tags() {
  try {
    return git('tag', '--list', 'v*')
      .split('\n')
      .filter((t) => parseVersion(t))
  } catch {
    return []
  }
}

if (args.includes('--next')) {
  const last = tags().sort(compareVersions).at(-1)
  if (!last) {
    console.error('release:next: no v* tags found — fetch tags first')
    process.exit(1)
  }
  const log = git('log', `${last}..HEAD`, '--no-merges', '--format=%B%x00')
  const commits = log
    .split('\0')
    .map((m) => m.trim())
    .filter(Boolean)
  const { version, bump } = nextVersion(last, commits)
  if (!version) {
    console.log(`No Conventional Commits since ${last}; nothing to release.`)
    process.exit(0)
  }
  const headers = commits.map((m) => m.split('\n')[0])
  const notable = headers.filter((h) => /^(feat|\w+(\([^)]*\))?!)/.test(h))
  console.log(`Last release: ${last}`)
  console.log(`Commits since: ${commits.length}`)
  console.log(`Suggested: v${version} (${bump})`)
  if (notable.length > 0) {
    console.log('\nWhat drives the bump:')
    for (const h of notable) console.log(`  ${h}`)
  }
  process.exit(0)
}

const tagArg = args[args.indexOf('--tag') + 1]
const tag = args.includes('--tag') ? tagArg : `v${pkg.version}`
const problems = []

if (!parseVersion(tag)) {
  console.error(`release:check: "${tag}" is not a vX.Y.Z version`)
  process.exit(1)
}
const version = tag.replace(/^v/, '')

// 1. package.json names the same version.
if (pkg.version !== version) {
  problems.push(
    `package.json version is ${pkg.version}, but the release is ${version}`,
  )
}

// 2. The CHANGELOG has a dated section for it, with entries in it.
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const section = changelogSection(changelog, version)
if (section === null) {
  problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`)
} else {
  const heading = changelog
    .split('\n')
    .find((l) => l.startsWith(`## [${version}]`))
  if (!/ - \d{4}-\d{2}-\d{2}$/.test(heading)) {
    problems.push(
      `CHANGELOG.md heading "${heading}" has no " - YYYY-MM-DD" date`,
    )
  }
  if (!sectionHasEntries(section)) {
    problems.push(`CHANGELOG.md section [${version}] is empty`)
  }
}

// 3. [Unreleased] was rolled into the release rather than left behind.
const unreleased = changelogSection(changelog, 'Unreleased')
if (unreleased === null) {
  problems.push(
    'CHANGELOG.md has no "## [Unreleased]" section to collect the next changes',
  )
} else if (sectionHasEntries(unreleased)) {
  problems.push(
    'CHANGELOG.md [Unreleased] still has entries — move them into the release section',
  )
}

// 4. The version goes up. Skipped with a warning when no tags are fetched.
const others = tags().filter((t) => t !== tag)
if (others.length === 0) {
  console.warn('warning  no earlier v* tags found; version order not checked')
} else {
  const highest = others.sort(compareVersions).at(-1)
  if (compareVersions(tag, highest) <= 0) {
    problems.push(`${tag} is not higher than the latest release ${highest}`)
  }
}

// 5. No finished spec is left Proposed.
const specsDir = join(root, 'specs')
for (const file of readdirSync(specsDir).filter((f) =>
  /^\d{4}-.*\.md$/.test(f),
)) {
  const text = readFileSync(join(specsDir, file), 'utf8')
  const status = /^status:\s*['"]?(\w+)/m.exec(text)?.[1] ?? ''
  if (isFinishedButProposed(status, acceptanceCounts(text))) {
    problems.push(
      `specs/${file}: every acceptance criterion is ticked but the status is Proposed — mark it Shipped with release: ${tag}`,
    )
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`error    ${p}`)
  console.error(
    `\nrelease:check failed for ${tag} with ${problems.length} problem${problems.length === 1 ? '' : 's'}.`,
  )
  process.exit(1)
}
console.log(`release:check passed for ${tag}`)
