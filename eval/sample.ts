import './load-env'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GradedAnswer } from './graded-types'

/**
 * Draw answers to grade (#119).
 *
 *   pnpm rag:sample --from answers-118 [--per-slice 5]
 *
 * Reads `eval/results/<from>.json` from a `--answers` run and writes up to
 * `--per-slice` answers of each slice to `eval/graded/<questionId>.json`,
 * ungraded. Slices with fewer answers give what they have. A question
 * already in `eval/graded/` is never overwritten, so a second draw adds to
 * the sample. The draw is deterministic (sorted by question id), so it can
 * be repeated.
 */

const RESULTS = join(import.meta.dirname, 'results')
const GRADED = join(import.meta.dirname, 'graded')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

interface Check {
  questionId: string
  question: string
  type: string
  answer: string
  sources?: GradedAnswer['sources']
}

const from = arg('from')
if (!from) {
  console.error('Usage: pnpm rag:sample --from <results label> [--per-slice 5]')
  process.exit(1)
}
const perSlice = Number(arg('per-slice') ?? 5)
const file = join(RESULTS, `${from}.json`)
if (!existsSync(file)) {
  console.error(
    `No ${file}. Run pnpm rag:eval --answers --label ${from} first.`,
  )
  process.exit(1)
}
const run = JSON.parse(readFileSync(file, 'utf8')) as {
  label: string
  at: string
  answerChecks?: Check[]
}
const answered = (run.answerChecks ?? []).filter(
  (c) => c.sources?.length && c.answer,
)
if (answered.length === 0) {
  console.error(
    `${from}.json has no answers with sources; was it run with --answers?`,
  )
  process.exit(1)
}

mkdirSync(GRADED, { recursive: true })
const written: string[] = []
for (const slice of [...new Set(answered.map((c) => c.type))].sort()) {
  const pick = answered
    .filter((c) => c.type === slice)
    .sort((a, b) => a.questionId.localeCompare(b.questionId))
    .slice(0, perSlice)
  for (const c of pick) {
    const out = join(GRADED, `${c.questionId}.json`)
    if (existsSync(out)) continue
    const graded: GradedAnswer = {
      questionId: c.questionId,
      type: c.type,
      question: c.question,
      answer: c.answer,
      sources: c.sources!,
      drawnFrom: { label: run.label, at: run.at },
      grade: null,
    }
    writeFileSync(out, `${JSON.stringify(graded, null, 2)}\n`)
    written.push(`${slice}: ${c.questionId}`)
  }
}
console.log(`Wrote ${written.length} answers to eval/graded/:`)
for (const w of written) console.log(`  ${w}`)
