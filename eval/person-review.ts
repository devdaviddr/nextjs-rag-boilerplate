/**
 * Person review of the Claude-drafted grades (#119, #120).
 *
 *   pnpm rag:review:export
 *   pnpm rag:review:import
 *
 * Export writes a blank sheet. Import checks the filled sheet, stores the
 * person's grade on `personGrade`, and leaves the draft in `grade`. The
 * agreement report compares the draft (the judge) with the person (gold).
 * This module does not grade anything and does not invent person scores.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  confusionTable,
  cohensKappa,
  formatKappa,
  formatPercent,
  judgePersonAgreement,
  type AgreementStats,
} from './agreement'
import {
  faithfulnessOf,
  type GradedAnswer,
  type GradedClaim,
  type Grade,
} from './graded-types'

export const REVIEW_COLUMNS = [
  'id',
  'type',
  'question',
  'sources',
  'answer',
  'draft_grade',
  'draft_rationale',
  'draft_claims',
  'draft_completeness',
  'person_faithfulness',
  'person_completeness',
  'agree',
  'notes',
] as const

export type ReviewColumn = (typeof REVIEW_COLUMNS)[number]

export interface ReviewRow {
  line: number
  id: string
  type: string
  question: string
  sources: string
  answer: string
  draft_grade: string
  draft_rationale: string
  draft_claims: string
  draft_completeness: string
  person_faithfulness: string
  person_completeness: string
  agree: string
  notes: string
}

export interface ValidReview {
  id: string
  decision: 'agree' | 'disagree'
  /** Scores in claim order. Empty when the draft has no claims. Used when the decision is disagree. */
  faithfulness: Array<0 | 1 | 2>
  completeness: 0 | 1 | 2
  notes: string
}

export function isClaudeDraft(answer: GradedAnswer): boolean {
  const grade = answer.grade
  return !!grade && !grade.reviewed && /claude/i.test(grade.grader)
}

/** Machine-readable draft scores, in claim order. ASCII, so a spreadsheet save leaves it alone. */
export function draftClaimsToken(grade: Grade): string {
  return grade.claims.map((c) => `S${c.sentence}:${c.faithfulness}`).join(',')
}

export function formatDraftGrade(grade: Grade): string {
  const faith =
    grade.claims.length === 0
      ? 'n/a (no factual claims)'
      : `${faithfulnessOf(grade)!.toFixed(2)} (${grade.claims
          .map((c) => `S${c.sentence}=${c.faithfulness}`)
          .join(', ')})`
  return `faithfulness: ${faith}\ncompleteness: ${grade.completeness}`
}

export function formatRationale(grade: Grade): string {
  const lines: string[] = []
  if (grade.completenessNote) {
    lines.push(`completeness: ${grade.completenessNote}`)
  }
  for (const claim of grade.claims) {
    lines.push(`S${claim.sentence} (${claim.faithfulness}): ${claim.text}`)
    if (claim.note) lines.push(`  note: ${claim.note}`)
  }
  return lines.join('\n')
}

export function formatSources(answer: GradedAnswer): string {
  return answer.sources
    .map(
      (source, i) =>
        `[${i + 1}] ${source.document}, page ${source.page} (${source.id})\n${source.content}`,
    )
    .join('\n\n')
}

export function loadDrafts(dir: string): Array<{
  file: string
  answer: GradedAnswer
}> {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = join(dir, name)
      const answer = JSON.parse(readFileSync(file, 'utf8')) as GradedAnswer
      return { file, answer }
    })
    .filter((item) => isClaudeDraft(item.answer))
    .sort((a, b) => {
      const byType = a.answer.type.localeCompare(b.answer.type)
      if (byType !== 0) return byType
      return a.answer.questionId.localeCompare(b.answer.questionId)
    })
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`
  return value
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((row) => row.map(csvField).join(',')).join('\n')}\n`
}

export function reviewCells(answer: GradedAnswer): string[] {
  const grade = answer.grade
  if (!grade) throw new Error(`${answer.questionId} has no draft grade`)
  return [
    answer.questionId,
    answer.type,
    answer.question,
    formatSources(answer),
    answer.answer,
    formatDraftGrade(grade),
    formatRationale(grade),
    draftClaimsToken(grade),
    String(grade.completeness),
    '',
    '',
    '',
    '',
  ]
}

/** UTF-8 with a BOM so a spreadsheet keeps the punctuation in the answers. */
export function renderCsv(answers: readonly GradedAnswer[]): string {
  return `\uFEFF${toCsv([
    [...REVIEW_COLUMNS],
    ...answers.map((answer) => reviewCells(answer)),
  ])}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function renderHtml(answers: readonly GradedAnswer[]): string {
  const items = answers
    .map((answer) => {
      const grade = answer.grade
      if (!grade) return ''
      const claims =
        grade.claims.length === 0
          ? '<p>No factual claims. Completeness is the whole grade.</p>'
          : `<table>
        <thead><tr><th>Sentence</th><th>Score</th><th>Claim</th><th>Rationale</th></tr></thead>
        <tbody>
          ${grade.claims
            .map(
              (claim) => `<tr>
              <td>S${claim.sentence}</td>
              <td>${claim.faithfulness}</td>
              <td>${escapeHtml(claim.text)}</td>
              <td>${escapeHtml(claim.note ?? '')}</td>
            </tr>`,
            )
            .join('\n')}
        </tbody>
      </table>`
      return `<section id="${escapeHtml(answer.questionId)}">
        <h2>${escapeHtml(answer.questionId)}</h2>
        <p><strong>${escapeHtml(answer.type)}</strong></p>
        <h3>Question</h3>
        <p>${escapeHtml(answer.question)}</p>
        <h3>Retrieved context</h3>
        <pre>${escapeHtml(formatSources(answer))}</pre>
        <h3>Model answer</h3>
        <pre>${escapeHtml(answer.answer)}</pre>
        <h3>Claude's draft grade</h3>
        <pre>${escapeHtml(formatDraftGrade(grade))}</pre>
        <p>Claim token (do not edit in the CSV): <code>${escapeHtml(draftClaimsToken(grade)) || '(none)'}</code></p>
        ${claims}
        <p>Completeness: <strong>${grade.completeness}</strong></p>
        ${
          grade.completenessNote
            ? `<p>Completeness rationale: ${escapeHtml(grade.completenessNote)}</p>`
            : ''
        }
        <p class="blank">Person grade, agree/disagree and notes are blank. Fill them on this item's row in <code>person-review.csv</code>.</p>
      </section>`
    })
    .join('\n')

  const toc = answers
    .map(
      (answer) =>
        `<li><a href="#${escapeHtml(answer.questionId)}">${escapeHtml(answer.questionId)}</a> <span>${escapeHtml(answer.type)}</span></li>`,
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Person review — ${answers.length} drafted answers</title>
  <style>
    body { font: 16px/1.45 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    pre { white-space: pre-wrap; background: #f4f4f4; padding: 0.75rem 1rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 0.35rem 0.5rem; vertical-align: top; }
    section { border-top: 1px solid #ccc; padding: 1.5rem 0; }
    .blank { color: #555; }
    code { font-size: 0.95em; }
  </style>
</head>
<body>
  <h1>Person review of drafted grades</h1>
  <p>${answers.length} items. This file is for reading. It contains no person grades. Enter grades in <code>eval/review/person-review.csv</code>. Steps: <code>docs/person-review.md</code>.</p>
  <h2>Rubric</h2>
  <p>Faithfulness, per factual sentence: <strong>2</strong> fully supported, <strong>1</strong> partly supported or overstated, <strong>0</strong> unsupported or contradicted. Completeness, for the answer: <strong>2</strong> everything the sources hold that was asked, <strong>1</strong> misses part, <strong>0</strong> misses the point or refuses when the sources answer. A correct refusal is complete.</p>
  <h2>What to type</h2>
  <ul>
    <li><code>agree</code> is <code>agree</code> or <code>disagree</code>.</li>
    <li>On agree, leave <code>person_faithfulness</code> and <code>person_completeness</code> empty.</li>
    <li>On disagree, set <code>person_completeness</code> to 0, 1 or 2. Set <code>person_faithfulness</code> to one score per claim, in the claim-token order (<code>2,0</code>) or with sentence numbers (<code>S1:2,S2:0</code>). Leave it empty when the draft has no claims.</li>
    <li><code>notes</code> is optional. Do not edit <code>draft_claims</code> or <code>draft_completeness</code>.</li>
  </ul>
  <h2>Items</h2>
  <ol>
    ${toc}
  </ol>
  ${items}
</body>
</html>
`
}

interface CsvRecord {
  line: number
  cells: string[]
}

/** RFC 4180. A trailing newline does not add a row. A leading BOM is ignored. */
export function parseCsv(
  input: string,
): { ok: true; records: CsvRecord[] } | { ok: false; error: string } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const records: CsvRecord[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let justClosed = false
  let fieldStart = true
  let line = 1
  let recordLine = 1

  const endField = () => {
    row.push(field)
    field = ''
    fieldStart = true
    justClosed = false
  }
  const endRecord = () => {
    endField()
    records.push({ line: recordLine, cells: row })
    row = []
    recordLine = line
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
          justClosed = true
        }
        continue
      }
      field += c
      if (c === '\n') line += 1
      continue
    }

    if (c === '"') {
      if (!fieldStart || justClosed) {
        return { ok: false, error: `line ${line}: unexpected quote` }
      }
      quoted = true
      fieldStart = false
      continue
    }
    if (c === ',') {
      endField()
      continue
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1
      line += 1
      endRecord()
      continue
    }
    if (justClosed) {
      return {
        ok: false,
        error: `line ${line}: unexpected character after a quoted field`,
      }
    }
    field += c
    fieldStart = false
  }

  if (quoted) return { ok: false, error: `line ${line}: unclosed quote` }
  if (field.length > 0 || row.length > 0 || justClosed) endRecord()

  while (
    records.length > 0 &&
    records[records.length - 1]!.cells.every((cell) => cell === '')
  ) {
    records.pop()
  }
  return { ok: true, records }
}

export function parseReviewCsv(
  input: string,
): { ok: true; rows: ReviewRow[] } | { ok: false; error: string } {
  const parsed = parseCsv(input)
  if (!parsed.ok) return parsed
  const [header, ...rest] = parsed.records
  if (!header) return { ok: false, error: 'the sheet is empty' }
  const expected = REVIEW_COLUMNS.join(',')
  if (header.cells.join(',') !== expected) {
    return {
      ok: false,
      error: `header must be ${expected}`,
    }
  }
  const rows: ReviewRow[] = []
  const errors: string[] = []
  for (const record of rest) {
    if (record.cells.length !== REVIEW_COLUMNS.length) {
      errors.push(
        `line ${record.line}: expected ${REVIEW_COLUMNS.length} columns, got ${record.cells.length}`,
      )
      continue
    }
    const row = { line: record.line } as ReviewRow
    REVIEW_COLUMNS.forEach((column, index) => {
      row[column] = record.cells[index] ?? ''
    })
    rows.push(row)
  }
  if (errors.length > 0) return { ok: false, error: errors.join('\n') }
  return { ok: true, rows }
}

export function sheetHasResponses(csv: string): boolean {
  const parsed = parseReviewCsv(csv)
  if (!parsed.ok) return true
  return parsed.rows.some(
    (row) =>
      row.agree.trim() !== '' ||
      row.person_faithfulness.trim() !== '' ||
      row.person_completeness.trim() !== '' ||
      row.notes.trim() !== '',
  )
}

function parseCompleteness(raw: string): 0 | 1 | 2 | null {
  const text = raw.trim()
  if (text === '0' || text === '1' || text === '2') {
    return Number(text) as 0 | 1 | 2
  }
  return null
}

function parseFaithfulness(
  raw: string,
  claims: readonly GradedClaim[],
): { ok: true; scores: Array<0 | 1 | 2> } | { ok: false; error: string } {
  const text = raw.trim()
  if (claims.length === 0) {
    if (text === '') return { ok: true, scores: [] }
    return {
      ok: false,
      error: 'person_faithfulness must be empty when the draft has no claims',
    }
  }
  if (text === '') {
    return { ok: false, error: 'person_faithfulness is empty' }
  }
  const tokens = text.split(',').map((token) => token.trim())
  if (tokens.some((token) => token === '')) {
    return { ok: false, error: 'person_faithfulness has an empty score' }
  }
  const tagged = tokens.every((token) => /^S\d+:[012]$/.test(token))
  if (tagged) {
    const sentences = claims.map((claim) => claim.sentence)
    if (new Set(sentences).size !== sentences.length) {
      return {
        ok: false,
        error:
          'this draft repeats a sentence number; list scores in claim order instead',
      }
    }
    const bySentence = new Map<number, 0 | 1 | 2>()
    for (const token of tokens) {
      const [sentenceText, scoreText] = token.slice(1).split(':')
      const sentence = Number(sentenceText)
      if (bySentence.has(sentence)) {
        return {
          ok: false,
          error: `person_faithfulness repeats S${sentence}`,
        }
      }
      bySentence.set(sentence, Number(scoreText) as 0 | 1 | 2)
    }
    const missing = sentences.filter((sentence) => !bySentence.has(sentence))
    const extra = [...bySentence.keys()].filter(
      (sentence) => !sentences.includes(sentence),
    )
    if (
      missing.length > 0 ||
      extra.length > 0 ||
      tokens.length !== claims.length
    ) {
      return {
        ok: false,
        error: `person_faithfulness must score exactly ${claims.map((claim) => `S${claim.sentence}`).join(', ')}`,
      }
    }
    return {
      ok: true,
      scores: sentences.map((sentence) => bySentence.get(sentence)!),
    }
  }
  if (tokens.every((token) => /^[012]$/.test(token))) {
    if (tokens.length !== claims.length) {
      return {
        ok: false,
        error: `person_faithfulness must have ${claims.length} score${claims.length === 1 ? '' : 's'} (one per claim), got ${tokens.length}`,
      }
    }
    return {
      ok: true,
      scores: tokens.map((token) => Number(token) as 0 | 1 | 2),
    }
  }
  return {
    ok: false,
    error:
      'person_faithfulness must be scores like 2,0 or sentence scores like S1:2,S2:0',
  }
}

export function validateReviews(
  rows: readonly ReviewRow[],
  answers: readonly GradedAnswer[],
):
  | { ok: true; reviews: Map<string, ValidReview> }
  | { ok: false; errors: string[] } {
  const errors: string[] = []
  const reviews = new Map<string, ValidReview>()
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]))
  const seen = new Map<string, number>()

  for (const row of rows) {
    const id = row.id.trim()
    const where = `line ${row.line} (${id || 'no id'})`
    if (!id) {
      errors.push(`${where}: id is empty`)
      continue
    }
    if (seen.has(id)) {
      errors.push(`${where}: duplicate id ${id} (also on line ${seen.get(id)})`)
      continue
    }
    seen.set(id, row.line)
    const answer = byId.get(id)
    if (!answer?.grade) {
      errors.push(`${where}: no Claude draft in eval/graded for ${id}`)
      continue
    }
    const grade = answer.grade
    if (row.draft_claims.trim() !== draftClaimsToken(grade)) {
      errors.push(
        `${where}: draft_claims does not match the draft. Leave that column as exported.`,
      )
    }
    if (row.draft_completeness.trim() !== String(grade.completeness)) {
      errors.push(
        `${where}: draft_completeness does not match the draft. Leave that column as exported.`,
      )
    }

    const decision = row.agree.trim().toLowerCase()
    if (decision !== 'agree' && decision !== 'disagree') {
      errors.push(`${where}: agree must be "agree" or "disagree"`)
      continue
    }
    const notes = row.notes.trim()
    if (decision === 'agree') {
      if (
        row.person_faithfulness.trim() !== '' ||
        row.person_completeness.trim() !== ''
      ) {
        errors.push(
          `${where}: agree is "agree", so person_faithfulness and person_completeness must be empty`,
        )
        continue
      }
      reviews.set(id, {
        id,
        decision,
        faithfulness: grade.claims.map((claim) => claim.faithfulness),
        completeness: grade.completeness,
        notes,
      })
      continue
    }

    const completeness = parseCompleteness(row.person_completeness)
    if (completeness === null) {
      errors.push(`${where}: person_completeness must be 0, 1 or 2`)
    }
    const faithfulness = parseFaithfulness(
      row.person_faithfulness,
      grade.claims,
    )
    if (!faithfulness.ok) errors.push(`${where}: ${faithfulness.error}`)
    if (completeness === null || !faithfulness.ok) continue
    reviews.set(id, {
      id,
      decision,
      faithfulness: faithfulness.scores,
      completeness,
      notes,
    })
  }

  for (const answer of answers) {
    if (!seen.has(answer.questionId)) {
      errors.push(`missing row for ${answer.questionId}`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, reviews }
}

export function withPersonGrade(
  answer: GradedAnswer,
  review: ValidReview,
  meta: { grader: string; gradedAt: string },
): GradedAnswer {
  const draft = answer.grade
  if (!draft) throw new Error(`${answer.questionId} has no draft grade`)
  const claims: GradedClaim[] = draft.claims.map((claim, index) => ({
    sentence: claim.sentence,
    text: claim.text,
    faithfulness:
      review.decision === 'agree'
        ? claim.faithfulness
        : review.faithfulness[index]!,
  }))
  const personGrade: Grade = {
    claims,
    completeness:
      review.decision === 'agree' ? draft.completeness : review.completeness,
    grader: meta.grader,
    reviewed: true,
    gradedAt: meta.gradedAt,
    agreesWithDraft: review.decision === 'agree',
    ...(review.notes ? { reviewNotes: review.notes } : {}),
  }
  return { ...answer, personGrade }
}

export interface ImportSuccess {
  ok: true
  answers: GradedAnswer[]
  report: string
  faithfulness: AgreementStats
  completeness: AgreementStats
  claims: AgreementStats
}

export function importSheet(options: {
  csv: string
  answers: readonly GradedAnswer[]
  grader: string
  gradedAt: string
}): ImportSuccess | { ok: false; errors: string[] } {
  const grader = options.grader.trim()
  if (!grader) return { ok: false, errors: ['grader name is empty'] }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.gradedAt)) {
    return { ok: false, errors: ['gradedAt must be YYYY-MM-DD'] }
  }
  const parsed = parseReviewCsv(options.csv)
  if (!parsed.ok) return { ok: false, errors: [parsed.error] }
  const validated = validateReviews(parsed.rows, options.answers)
  if (!validated.ok) return validated

  const answers = options.answers.map((answer) =>
    withPersonGrade(answer, validated.reviews.get(answer.questionId)!, {
      grader,
      gradedAt: options.gradedAt,
    }),
  )
  const report = agreementReport({
    generatedAt: options.gradedAt,
    grader,
    answers,
  })
  return {
    ok: true,
    answers,
    report: report.markdown,
    faithfulness: report.faithfulness,
    completeness: report.completeness,
    claims: report.claims,
  }
}

export function agreementReport(options: {
  generatedAt: string
  grader: string
  answers: readonly GradedAnswer[]
}): {
  markdown: string
  faithfulness: AgreementStats
  completeness: AgreementStats
  claims: AgreementStats
} {
  const scored = options.answers.filter(
    (answer): answer is GradedAnswer & { grade: Grade; personGrade: Grade } =>
      !!answer.grade && !!answer.personGrade,
  )
  const level = judgePersonAgreement(
    scored.map((answer) => ({
      gold: {
        faithfulness: faithfulnessOf(answer.personGrade),
        completeness: answer.personGrade.completeness,
      },
      judge: {
        faithfulness: faithfulnessOf(answer.grade),
        completeness: answer.grade.completeness,
      },
    })),
  )
  const claimPairs = scored.flatMap((answer) =>
    answer.grade.claims.map((claim, index) => ({
      gold: answer.personGrade.claims[index]?.faithfulness ?? -1,
      judge: claim.faithfulness,
    })),
  )
  const claims = cohensKappa(
    claimPairs.filter(
      (pair) => pair.gold === 0 || pair.gold === 1 || pair.gold === 2,
    ),
  )
  const agreed = scored.filter(
    (answer) => answer.personGrade.agreesWithDraft,
  ).length
  const omitted = scored.filter(
    (answer) =>
      faithfulnessOf(answer.grade) === null ||
      faithfulnessOf(answer.personGrade) === null,
  ).length

  const differences = scored.flatMap((answer) => {
    const draftFaith = faithfulnessOf(answer.grade)
    const personFaith = faithfulnessOf(answer.personGrade)
    const faithDiffers =
      (draftFaith === null) !== (personFaith === null) ||
      (draftFaith !== null &&
        personFaith !== null &&
        Math.round(draftFaith) !== Math.round(personFaith))
    const completenessDiffers =
      answer.grade.completeness !== answer.personGrade.completeness
    if (!faithDiffers && !completenessDiffers) return []
    const faith = (value: number | null) =>
      value === null ? 'n/a' : String(Math.round(value))
    const notes = answer.personGrade.reviewNotes
      ? `\n  notes: ${answer.personGrade.reviewNotes}`
      : ''
    return [
      `- \`${answer.questionId}\` — faithfulness ${faith(personFaith)} (person) vs ${faith(draftFaith)} (draft); completeness ${answer.personGrade.completeness} (person) vs ${answer.grade.completeness} (draft)${notes}`,
    ]
  })

  const section = (title: string, body: string, stats: AgreementStats) =>
    `## ${title}

${body}

- Items: ${stats.n}
- Agreement: ${formatPercent(stats)}
- Cohen's kappa: ${formatKappa(stats.kappa, stats.n)}

${confusionTable(stats, 'person', 'draft')}
`

  const markdown = `# Judge agreement (Claude draft vs person)

Generated: ${options.generatedAt}
Grader: ${options.grader}
Items: ${scored.length}
Sheet decisions: ${agreed} agree, ${scored.length - agreed} disagree.

The judge is Claude's draft, still stored on \`grade\`. The person grade on \`personGrade\` is the gold label. This report only counts rows imported from the review sheet. It does not fill in grades.

Answer-level faithfulness is the mean claim score, rounded to the nearest of 0, 1 or 2, which is how \`pnpm rag:judge\` compares a model judge with a person. ${omitted} item${omitted === 1 ? '' : 's'} with no factual claims ${omitted === 1 ? 'is' : 'are'} left out of that faithfulness figure. The 80% target in \`docs/rag.md\` applies to the model judge, not to this draft comparison.

${section(
  'Faithfulness (answer)',
  'Person rows, draft columns.',
  level.faithfulness,
)}
${section(
  'Completeness',
  'One grade for the whole answer.',
  level.completeness,
)}
${section(
  'Faithfulness (claims)',
  'Each drafted factual sentence, scored on its own. Same claim list on both sides.',
  claims,
)}
## Where the answer-level grades differ

${differences.length > 0 ? differences.join('\n') : 'No answer-level grades differ.'}
`
  return {
    markdown,
    faithfulness: level.faithfulness,
    completeness: level.completeness,
    claims,
  }
}
