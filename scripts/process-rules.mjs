// The rules behind the PR check and the release check, as pure functions so
// they can be unit-tested (tests/unit/process-rules.test.ts) without git, the
// GitHub API or the file system.
//
//   scripts/pr-check.mjs       runs on every pull request (.github/workflows/pr.yml)
//   scripts/release-check.mjs  runs on every v* tag (ci.yml → release) and in /ship
//
// The process they enforce is written down in CONTRIBUTING.md and
// docs/workflow.md; change the prose and the rules together.

/** Conventional Commit types, matching @commitlint/config-conventional. */
export const COMMIT_TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
]

/**
 * Types whose changes a user of the template can notice, so they need a
 * CHANGELOG entry unless the PR carries the `no-changelog` label.
 */
export const USER_FACING_TYPES = ['feat', 'fix', 'perf', 'revert']

/**
 * Parses a Conventional Commit header (`type(scope)!: subject`). Returns null
 * when the header does not have that shape. Validating the full rule set is
 * commitlint's job; this only extracts what the other rules need.
 */
export function parseHeader(header) {
  const match = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/.exec(header.trim())
  if (!match) return null
  return {
    type: match[1],
    scope: match[2] ?? null,
    breaking: match[3] === '!',
    subject: match[4],
  }
}

/**
 * Issue numbers a PR body links with a closing or tracking keyword:
 * `Closes #12`, `fixes #3`, `Resolves #7`, `Part of #19`. A bare `#12`
 * mention does not count — it neither closes the issue nor says the PR is its
 * work.
 */
export function linkedIssues(body) {
  const found = new Set()
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of)\s+#(\d+)\b/gi
  for (const match of (body ?? '').matchAll(re)) found.add(Number(match[1]))
  return [...found].sort((a, b) => a - b)
}

/** Whether a PR with this title must touch CHANGELOG.md. */
export function changelogRequired(title) {
  const header = parseHeader(title)
  if (!header) return false
  return header.breaking || USER_FACING_TYPES.includes(header.type)
}

/**
 * The problems with a pull request, as plain sentences. An empty array means
 * it passes. Bots (Renovate, Dependabot) are exempt from the issue link, since
 * they open PRs nobody filed an issue for.
 */
export function prProblems({ title, body, labels, author, changedFiles }) {
  const problems = []
  const isBot = /\[bot\]$/.test(author ?? '')

  if (!parseHeader(title ?? '')) {
    problems.push(
      `The title "${title}" is not a Conventional Commit header, e.g. "feat(rag): add reranking".`,
    )
  }
  if (!isBot && linkedIssues(body).length === 0) {
    problems.push(
      'The description links no issue. Add "Closes #N" (or "Part of #N" for partial work) for the issue on the project board.',
    )
  }
  if (
    changelogRequired(title ?? '') &&
    !(labels ?? []).includes('no-changelog') &&
    !(changedFiles ?? []).includes('CHANGELOG.md')
  ) {
    problems.push(
      'A feat, fix, perf, revert or breaking change needs a CHANGELOG.md entry under [Unreleased]. If users cannot notice this change, add the no-changelog label instead.',
    )
  }
  return problems
}

/** Parses `X.Y.Z` (with an optional leading `v`) into numbers, or null. */
export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((version ?? '').trim())
  if (!match) return null
  return match.slice(1, 4).map(Number)
}

/** Negative, zero or positive, like a sort comparator. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/**
 * The next version from the Conventional Commits since the last release.
 *
 * Pre-1.0 (the current state), the leading zero shifts everything down one
 * place, as SemVer allows: a breaking change bumps the minor, anything else
 * bumps the patch. `feat` also bumps the minor pre-1.0 — a new capability is
 * what a minor has meant in this repo's history (0.19.0 → 0.20.0 added RAG).
 * From 1.0 on: breaking → major, feat → minor, everything else → patch.
 *
 * `commits` is the full message of each commit (header plus body), because a
 * breaking change can be flagged with a `BREAKING CHANGE:` footer as well as
 * `!` in the header. Commits that are not Conventional are ignored.
 */
export function nextVersion(current, commits) {
  const [major, minor, patch] = parseVersion(current)
  let breaking = false
  let feature = false
  let any = false

  for (const message of commits) {
    const header = parseHeader(message.split('\n')[0])
    if (!header) continue
    any = true
    if (header.breaking || /^BREAKING[ -]CHANGE:/m.test(message)) {
      breaking = true
    }
    if (header.type === 'feat') feature = true
  }

  if (!any) return { version: null, bump: 'none' }
  if (major === 0) {
    if (breaking || feature) {
      return { version: `0.${minor + 1}.0`, bump: 'minor' }
    }
    return { version: `0.${minor}.${patch + 1}`, bump: 'patch' }
  }
  if (breaking) return { version: `${major + 1}.0.0`, bump: 'major' }
  if (feature) return { version: `${major}.${minor + 1}.0`, bump: 'minor' }
  return { version: `${major}.${minor}.${patch + 1}`, bump: 'patch' }
}

/**
 * The body of one `## [X.Y.Z]` (or `## [Unreleased]`) section of a Keep a
 * Changelog file, up to the next `## [` heading. Null if the heading is absent.
 */
export function changelogSection(text, name) {
  const lines = text.split('\n')
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = lines.findIndex((l) =>
    new RegExp(`^## \\[${escaped}\\]`).test(l),
  )
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^## \[/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** Whether a changelog section says anything beyond empty `###` headings. */
export function sectionHasEntries(section) {
  return section
    .split('\n')
    .some((l) => l.trim() !== '' && !/^###\s/.test(l.trim()))
}

/**
 * The acceptance-criteria checkboxes of a spec, counted only inside its
 * `## Acceptance criteria` section so a checklist elsewhere in the spec does
 * not count.
 */
export function acceptanceCounts(specText) {
  const lines = specText.split('\n')
  const start = lines.findIndex((l) => /^## Acceptance criteria/.test(l))
  if (start === -1) return { ticked: 0, open: 0 }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^## /.test(l))
  const section = (end === -1 ? rest : rest.slice(0, end)).join('\n')
  return {
    ticked: (section.match(/^\s*- \[x\]/gim) ?? []).length,
    open: (section.match(/^\s*- \[ \]/gm) ?? []).length,
  }
}

/**
 * A spec whose acceptance criteria are all ticked but whose status is still
 * Proposed is finished work nobody released — the drift that left five specs
 * behind after v0.20.1.
 */
export function isFinishedButProposed(status, counts) {
  return status === 'Proposed' && counts.ticked > 0 && counts.open === 0
}
