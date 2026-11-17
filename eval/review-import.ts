import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { formatKappa, formatPercent } from './agreement'
import { loadDrafts, importSheet } from './person-review'

/**
 * Import a filled person-review sheet (#119, #120).
 *
 *   pnpm rag:review:import [--grader Daniel] [--sheet path] [--report path]
 *
 * Checks every row. On any problem, writes nothing. On success, writes
 * personGrade beside the untouched Claude draft and an agreement report.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    console.error(`--${name} needs a value`)
    process.exit(1)
  }
  return value
}

const root = import.meta.dirname
const sheetPath = arg('sheet') ?? join(root, 'review', 'person-review.csv')
const reportPath = arg('report') ?? join(root, 'review', 'agreement-report.md')
const grader = arg('grader') ?? 'Daniel'
const gradedAt = new Date().toISOString().slice(0, 10)

let csv: string
try {
  csv = readFileSync(sheetPath, 'utf8')
} catch {
  console.error(`No sheet at ${sheetPath}. Run pnpm rag:review:export first.`)
  process.exit(1)
}

const drafts = loadDrafts(join(root, 'graded'))
const result = importSheet({
  csv,
  answers: drafts.map((draft) => draft.answer),
  grader,
  gradedAt,
})
if (!result.ok) {
  for (const problem of result.errors) console.error(`error  ${problem}`)
  console.error(
    `\n${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}. No grades were written.`,
  )
  process.exit(1)
}

const byId = new Map(
  result.answers.map((answer) => [answer.questionId, answer]),
)
let replaced = 0
for (const draft of drafts) {
  if (draft.answer.personGrade) replaced += 1
  const next = byId.get(draft.answer.questionId)
  if (!next) {
    console.error(`missing imported grade for ${draft.answer.questionId}`)
    process.exit(1)
  }
  writeFileSync(draft.file, `${JSON.stringify(next, null, 2)}\n`)
}
writeFileSync(reportPath, result.report)
console.log(
  `Wrote person grades for ${result.answers.length} items (${replaced} replaced). Claude drafts were left as they were.\n` +
    `Agreement report: ${reportPath}\n` +
    `  faithfulness ${formatPercent(result.faithfulness)}, kappa ${formatKappa(result.faithfulness.kappa, result.faithfulness.n)}\n` +
    `  completeness ${formatPercent(result.completeness)}, kappa ${formatKappa(result.completeness.kappa, result.completeness.n)}`,
)
