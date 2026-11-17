import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  loadDrafts,
  renderCsv,
  renderHtml,
  sheetHasResponses,
} from './person-review'

/**
 * Write the blank person-review sheet (#119).
 *
 *   pnpm rag:review:export [--force]
 *
 * Writes eval/review/person-review.csv and person-review.html for every
 * unreviewed Claude draft in eval/graded/. Person columns are empty.
 * Refuses to overwrite a CSV that already has responses unless --force.
 */

const root = import.meta.dirname
const outDir = join(root, 'review')
const csvPath = join(outDir, 'person-review.csv')
const htmlPath = join(outDir, 'person-review.html')
const force = process.argv.includes('--force')

if (
  !force &&
  existsSync(csvPath) &&
  sheetHasResponses(readFileSync(csvPath, 'utf8'))
) {
  console.error(
    'eval/review/person-review.csv already has responses. Re-run with --force to overwrite the sheet. Imported grades in eval/graded/ are not touched.',
  )
  process.exit(1)
}

const drafts = loadDrafts(join(root, 'graded'))
if (drafts.length === 0) {
  console.error('No unreviewed Claude drafts in eval/graded/.')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const answers = drafts.map((draft) => draft.answer)
writeFileSync(csvPath, renderCsv(answers))
writeFileSync(htmlPath, renderHtml(answers))
console.log(
  `Wrote ${drafts.length} items with empty person columns:\n  eval/review/person-review.csv\n  eval/review/person-review.html\nFill the CSV. Steps: docs/person-review.md`,
)
