import './load-env'

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { refreshAiSettings } from '@/lib/ai-settings'

import { confusionTable, formatKappa, judgePersonAgreement } from './agreement'
import {
  type GradedAnswer,
  faithfulnessOf,
  referenceGrade,
} from './graded-types'
import { AGREEMENT_TARGET, type JudgeScore, agreement } from './judge'
import { judgeAnswer, judgeModel, judgeModelWarning } from './judge-run'

/**
 * Does the judge agree with people? (#120)
 *
 *   pnpm rag:judge [--include-drafts]
 *
 * Runs the judge on every graded answer in `eval/graded/` that has a
 * reviewed person grade (`--include-drafts` uses unreviewed drafts when no
 * person grade is stored, for a first look only). Reports exact agreement
 * on faithfulness (rounded to its nearest grade) and completeness against
 * `AGREEMENT_TARGET`, plus Cohen's kappa and a confusion table. The judge's
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
  .flatMap((g) => {
    const gold = referenceGrade(g, { includeDrafts })
    return gold ? [{ answer: g, gold }] : []
  })

if (graded.length === 0) {
  console.error(
    'No reviewed grades in eval/graded/. Review the drafts first (docs/person-review.md), or pass --include-drafts for a first look.',
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
  const judge = await judgeAnswer(g.answer)
  const human = {
    faithfulness: faithfulnessOf(g.gold),
    completeness: g.gold.completeness,
  }
  rows.push({
    questionId: g.answer.questionId,
    type: g.answer.type,
    human,
    judge,
  })
  const f = (n: number | null) => (n === null ? '–' : n.toFixed(2))
  const differs =
    (human.faithfulness !== null &&
      judge.faithfulness !== null &&
      Math.round(human.faithfulness) !== Math.round(judge.faithfulness)) ||
    (judge.completeness !== null &&
      Math.round(judge.completeness) !== human.completeness)
  console.log(
    `  ${differs ? '≠' : '='} ${g.answer.questionId.padEnd(40)} faithfulness ${f(human.faithfulness)} vs ${f(judge.faithfulness)}  completeness ${human.completeness} vs ${judge.completeness ?? '–'}  (${judge.samples}/3 samples, spread ${f(judge.spread.faithfulness)})`,
  )
}

const result = agreement(rows)
const detail = judgePersonAgreement(
  rows.map((row) => ({
    gold: row.human,
    judge: {
      faithfulness: row.judge.faithfulness,
      completeness: row.judge.completeness,
    },
  })),
)
const pass = (n: number | null) => n !== null && n >= AGREEMENT_TARGET
console.log(
  `\nAgreement on ${result.answers} answers (target ${AGREEMENT_TARGET}):` +
    `\n  faithfulness ${result.faithfulness ?? '–'} ${pass(result.faithfulness) ? 'PASS' : 'FAIL'}  kappa ${formatKappa(detail.faithfulness.kappa, detail.faithfulness.n)}` +
    `\n  completeness ${result.completeness ?? '–'} ${pass(result.completeness) ? 'PASS' : 'FAIL'}  kappa ${formatKappa(detail.completeness.kappa, detail.completeness.n)}` +
    `\n\nFaithfulness, person (rows) vs judge (columns):\n${confusionTable(detail.faithfulness, 'person', 'judge')}` +
    `\n\nCompleteness, person (rows) vs judge (columns):\n${confusionTable(detail.completeness, 'person', 'judge')}`,
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
      kappa: {
        faithfulness: detail.faithfulness.kappa,
        completeness: detail.completeness.kappa,
      },
      confusion: {
        faithfulness: detail.faithfulness.confusion,
        completeness: detail.completeness.confusion,
      },
      rows,
    },
    null,
    2,
  ),
)
console.log(`Saved eval/results/judge-agreement.json`)
process.exit(0)
