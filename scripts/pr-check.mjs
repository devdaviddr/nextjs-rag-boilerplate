// Checks a pull request against the process in CONTRIBUTING.md: a Conventional
// Commit title, a linked issue, and a CHANGELOG entry for user-facing changes.
// Commit messages themselves are checked by commitlint in the same workflow.
//
// Runs in .github/workflows/pr.yml, which passes the PR in through the
// environment. To try it locally against your branch:
//
//   PR_TITLE="feat(rag): add reranking" PR_BODY="Closes #16" pnpm pr:check
//
// PR_LABELS is comma-separated. BASE_REF defaults to origin/main.
import { execFileSync } from 'node:child_process'

import { prProblems } from './process-rules.mjs'

const env = process.env
const base = env.BASE_REF || 'origin/main'

let changedFiles = []
try {
  changedFiles = execFileSync(
    'git',
    ['diff', '--name-only', `${base}...HEAD`],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean)
} catch {
  console.error(`pr-check: could not diff against ${base}; is it fetched?`)
  process.exit(1)
}

const problems = prProblems({
  title: env.PR_TITLE ?? '',
  body: env.PR_BODY ?? '',
  labels: (env.PR_LABELS ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean),
  author: env.PR_AUTHOR ?? '',
  changedFiles,
})

if (problems.length > 0) {
  for (const p of problems) console.error(`error    ${p}`)
  console.error(
    `\npr-check failed with ${problems.length} problem${problems.length === 1 ? '' : 's'}.`,
  )
  process.exit(1)
}
console.log('pr-check passed')
