import './load-env'

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { refreshAiSettings } from '@/lib/ai-settings'

import { type GradedAnswer, faithfulnessOf } from './graded-types'
import { AGREEMENT_TARGET, type JudgeScore, agreement } from './judge'
import { judgeAnswer, judgeModel, judgeModelWarning } from './judge-run'

/**
 * Does the judge agree with people? (#120)
 *
 *   pnpm rag:judge [--include-drafts]
 *
 * Runs the judge on every graded answer in `eval/graded/` whose grade a
 * person has reviewed (`--include-drafts` adds unreviewed ones, for a first
 * look only), and reports exact agreement on faithfulness (rounded to its
 * nearest grade) and completeness against `AGREEMENT_TARGET`. The judge's
 * numbers in `rag:eval --judge` are not to be trusted until this passes.
 */

const GRADED = join(import.meta.dirname, 'graded')
const includeDrafts = process.argv.includes('--include-drafts')

await refreshAiSettings()
const warning = judgeModelWarning()
if (warning) console.warn(`\n${warning}\n`)

const graded = readdirSync(GRADED)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(GRADED, f), 'utf8')) as GradedAnswer)
  .filter((g) => g.grade && (g.grade.reviewed || includeDrafts))

if (graded.length === 0) {
  console.error(
    'No reviewed grades in eval/graded/. Review the drafts first, or pass --include-drafts for a first look.',
  )
  process.exit(1)
}

console.log(
  `Judging ${graded.length} graded answers with ${judgeModel()}${includeDrafts ? ' (drafts included)' : ''}...\n`,
)
const rows: Array<{
  questionId: string
  type: string
  human: { faithfulness: number | null; completeness: number }
  judge: JudgeScore
}> = []
for (const g of graded) {
  const judge = await judgeAnswer(g)
  const human = {
    faithfulness: faithfulnessOf(g.grade!),
    completeness: g.grade!.completeness,
  }
  rows.push({ questionId: g.questionId, type: g.type, human, judge })
  const f = (n: number | null) => (n === null ? '–' : n.toFixed(2))
  const differs =
    (human.faithfulness !== null &&
      judge.faithfulness !== null &&
      Math.round(human.faithfulness) !== Math.round(judge.faithfulness)) ||
    (judge.completeness !== null &&
      Math.round(judge.completeness) !== human.completeness)
  console.log(
    `  ${differs ? '≠' : '='} ${g.questionId.padEnd(40)} faithfulness ${f(human.faithfulness)} vs ${f(judge.faithfulness)}  completeness ${human.completeness} vs ${judge.completeness ?? '–'}  (${judge.samples}/3 samples, spread ${f(judge.spread.faithfulness)})`,
  )
}

const result = agreement(rows)
const pass = (n: number | null) => n !== null && n >= AGREEMENT_TARGET
console.log(
  `\nAgreement on ${result.answers} answers (target ${AGREEMENT_TARGET}):` +
    `\n  faithfulness ${result.faithfulness ?? '–'} ${pass(result.faithfulness) ? 'PASS' : 'FAIL'}` +
    `\n  completeness ${result.completeness ?? '–'} ${pass(result.completeness) ? 'PASS' : 'FAIL'}`,
)
const out = join(import.meta.dirname, 'results', 'judge-agreement.json')
writeFileSync(
  out,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      judgeModel: judgeModel(),
      includeDrafts,
      target: AGREEMENT_TARGET,
      agreement: result,
      rows,
    },
    null,
    2,
  ),
)
console.log(`Saved eval/results/judge-agreement.json`)
process.exit(0)
