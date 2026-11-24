import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { cohensKappa, judgePersonAgreement } from '../../eval/agreement'
import {
  referenceGrade,
  type GradedAnswer,
  type Grade,
} from '../../eval/graded-types'
import { agreement, type JudgeScore } from '../../eval/judge'
import {
  REVIEW_COLUMNS,
  importSheet,
  isClaudeDraft,
  loadDrafts,
  parseCsv,
  parseReviewCsv,
  renderCsv,
  renderHtml,
  sheetHasResponses,
  toCsv,
  type ReviewRow,
} from '../../eval/person-review'

// Synthetic fixtures only. Nothing here is a real graded answer, and no
// person grade is invented for the sample in eval/graded/.

function synthetic(
  id: string,
  grade: Partial<Grade> & Pick<Grade, 'claims' | 'completeness'>,
  extra?: Partial<GradedAnswer>,
): GradedAnswer {
  return {
    questionId: id,
    type: 'synthetic',
    question: `Synthetic question for ${id}?`,
    answer: `Synthetic answer for ${id}.`,
    sources: [
      {
        id: 'synthetic-source',
        document: 'synthetic-doc',
        page: 1,
        content: 'Synthetic source text, with a comma.',
      },
    ],
    drawnFrom: { label: 'synthetic', at: '2026-01-01T00:00:00.000Z' },
    grade: {
      grader: 'Claude (draft)',
      reviewed: false,
      gradedAt: '2026-01-01',
      ...grade,
    },
    ...extra,
  }
}

const oneClaim = synthetic('synthetic-one', {
  claims: [
    {
      sentence: 1,
      text: 'Synthetic answer for synthetic-one.',
      faithfulness: 2,
      note: 'synthetic rationale',
    },
  ],
  completeness: 2,
  completenessNote: 'synthetic completeness note',
})

const twoClaims = synthetic('synthetic-two', {
  claims: [
    { sentence: 1, text: 'First synthetic claim.', faithfulness: 2 },
    { sentence: 2, text: 'Second synthetic claim.', faithfulness: 0 },
  ],
  completeness: 1,
})

const noClaims = synthetic('synthetic-none', {
  claims: [],
  completeness: 2,
  completenessNote: 'Synthetic correct refusal.',
})

const sample = [oneClaim, twoClaims, noClaims]

function decide(
  csv: string,
  decisions: Record<string, Partial<ReviewRow>> = {},
): string {
  const parsed = parseReviewCsv(csv)
  if (!parsed.ok) throw new Error(parsed.error)
  return toCsv([
    [...REVIEW_COLUMNS],
    ...parsed.rows.map((row) => {
      const next = { ...row, agree: 'agree', ...decisions[row.id] }
      return REVIEW_COLUMNS.map((column) => next[column])
    }),
  ])
}

describe('CSV', () => {
  it('round-trips commas, quotes and newlines', () => {
    const rows = [
      ['id', 'note'],
      ['synthetic-a', 'say "hi",\nthen stop'],
    ]
    const parsed = parseCsv(toCsv(rows))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.records.map((record) => record.cells)).toEqual(rows)
  })

  it('accepts a BOM and CRLF, and drops a trailing blank line', () => {
    const parsed = parseCsv('\uFEFFid,note\r\nsynthetic,"a"\r\n\r\n')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.records.map((record) => record.cells)).toEqual([
      ['id', 'note'],
      ['synthetic', 'a'],
    ])
  })

  it('rejects an unclosed quote', () => {
    const parsed = parseCsv('"synthetic')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/unclosed quote/)
  })
})

describe('export sheet', () => {
  it('leaves the person columns empty', () => {
    const tricky = synthetic('synthetic-tricky', {
      claims: [{ sentence: 1, text: 'A <script> claim.', faithfulness: 1 }],
      completeness: 0,
    })
    tricky.answer = 'Line one.\nLine "two", with a comma.'
    const csv = renderCsv([tricky])
    const parsed = parseReviewCsv(csv)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.rows).toHaveLength(1)
    const row = parsed.rows[0]!
    expect(row.person_faithfulness).toBe('')
    expect(row.person_completeness).toBe('')
    expect(row.agree).toBe('')
    expect(row.notes).toBe('')
    expect(row.answer).toBe(tricky.answer)
    expect(row.draft_claims).toBe('S1:1')
    expect(row.draft_completeness).toBe('0')
    expect(sheetHasResponses(csv)).toBe(false)

    const html = renderHtml([tricky])
    expect(html).toContain('Synthetic question for synthetic-tricky?')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('Person grade, agree/disagree and notes are blank')
  })
})

describe('import validation', () => {
  const blank = renderCsv(sample)

  it('accepts agree with empty person grades and disagree with scores', () => {
    const csv = decide(blank, {
      'synthetic-two': {
        agree: 'disagree',
        person_faithfulness: 'S2:1,S1:2',
        person_completeness: '0',
        notes: 'synthetic note',
      },
      'synthetic-none': { agree: 'disagree', person_completeness: '1' },
    })
    const result = importSheet({
      csv,
      answers: sample,
      grader: 'Daniel',
      gradedAt: '2026-11-17',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const one = result.answers[0]!
    expect(one.grade).toEqual(oneClaim.grade)
    expect(oneClaim.personGrade).toBeUndefined()
    expect(one.grade?.reviewed).toBe(false)
    expect(one.personGrade).toMatchObject({
      reviewed: true,
      grader: 'Daniel',
      gradedAt: '2026-11-17',
      agreesWithDraft: true,
      completeness: 2,
      claims: [
        { sentence: 1, faithfulness: 2, text: oneClaim.grade!.claims[0]!.text },
      ],
    })
    expect(one.personGrade?.claims[0]?.note).toBeUndefined()
    expect(one.personGrade?.completenessNote).toBeUndefined()

    const two = result.answers[1]!.personGrade!
    expect(two.agreesWithDraft).toBe(false)
    expect(two.claims.map((claim) => claim.faithfulness)).toEqual([2, 1])
    expect(two.completeness).toBe(0)
    expect(two.reviewNotes).toBe('synthetic note')
    expect(twoClaims.grade).toEqual(
      synthetic('synthetic-two', {
        claims: [
          { sentence: 1, text: 'First synthetic claim.', faithfulness: 2 },
          { sentence: 2, text: 'Second synthetic claim.', faithfulness: 0 },
        ],
        completeness: 1,
      }).grade,
    )

    const none = result.answers[2]!.personGrade!
    expect(none.claims).toEqual([])
    expect(none.completeness).toBe(1)
  })

  it('rejects a sheet that is not fully graded or uses a value outside 0, 1, 2', () => {
    const cases: Array<{ name: string; csv: string; match: RegExp }> = [
      {
        name: 'blank agree',
        csv: blank,
        match: /agree must be "agree" or "disagree"/,
      },
      {
        name: 'agree with a grade filled in',
        csv: decide(blank, {
          'synthetic-one': { agree: 'agree', person_completeness: '2' },
        }),
        match: /must be empty/,
      },
      {
        name: 'disagree without completeness',
        csv: decide(blank, {
          'synthetic-one': { agree: 'disagree', person_faithfulness: '2' },
        }),
        match: /person_completeness must be 0, 1 or 2/,
      },
      {
        name: 'too few claim scores',
        csv: decide(blank, {
          'synthetic-two': {
            agree: 'disagree',
            person_faithfulness: '2',
            person_completeness: '1',
          },
        }),
        match: /must have 2 scores/,
      },
      {
        name: 'score outside 0, 1, 2',
        csv: decide(blank, {
          'synthetic-one': {
            agree: 'disagree',
            person_faithfulness: '3',
            person_completeness: '2',
          },
        }),
        match: /person_faithfulness must be scores/,
      },
      {
        name: 'faithfulness on an item with no claims',
        csv: decide(blank, {
          'synthetic-none': {
            agree: 'disagree',
            person_faithfulness: '2',
            person_completeness: '2',
          },
        }),
        match: /must be empty when the draft has no claims/,
      },
      {
        name: 'edited draft token',
        csv: decide(blank).replace('S1:2', 'S1:0'),
        match: /draft_claims does not match/,
      },
    ]
    for (const testCase of cases) {
      const result = importSheet({
        csv: testCase.csv,
        answers: sample,
        grader: 'Daniel',
        gradedAt: '2026-11-17',
      })
      expect(result.ok, testCase.name).toBe(false)
      if (result.ok) continue
      expect(result.errors.join('\n'), testCase.name).toMatch(testCase.match)
    }
  })

  it('rejects a missing, extra or duplicate id and writes nothing', () => {
    const parsed = parseReviewCsv(decide(blank))
    if (!parsed.ok) throw new Error(parsed.error)
    const sheet = (rows: ReviewRow[]) =>
      toCsv([
        [...REVIEW_COLUMNS],
        ...rows.map((row) => REVIEW_COLUMNS.map((column) => row[column])),
      ])

    const missing = importSheet({
      csv: sheet(parsed.rows.filter((row) => row.id !== 'synthetic-none')),
      answers: sample,
      grader: 'Daniel',
      gradedAt: '2026-11-17',
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.errors.join('\n')).toMatch(
        /missing row for synthetic-none/,
      )
    }

    const extra = importSheet({
      csv: sheet([
        ...parsed.rows,
        { ...parsed.rows[0]!, id: 'synthetic-extra' },
      ]),
      answers: sample,
      grader: 'Daniel',
      gradedAt: '2026-11-17',
    })
    expect(extra.ok).toBe(false)
    if (!extra.ok) expect(extra.errors.join('\n')).toMatch(/no Claude draft/)

    const duplicate = importSheet({
      csv: sheet([...parsed.rows, parsed.rows[0]!]),
      answers: sample,
      grader: 'Daniel',
      gradedAt: '2026-11-17',
    })
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok)
      expect(duplicate.errors.join('\n')).toMatch(/duplicate id/)
  })

  it('does not touch a graded file when validation fails', () => {
    const dir = join(tmpdir(), `synthetic-person-review-${Date.now()}`)
    mkdirSync(dir)
    const file = join(dir, 'synthetic-one.json')
    const original = `${JSON.stringify(oneClaim, null, 2)}\n`
    writeFileSync(file, original)
    const result = importSheet({
      csv: renderCsv([oneClaim]),
      answers: [oneClaim],
      grader: 'Daniel',
      gradedAt: '2026-11-17',
    })
    expect(result.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(original)

    const imported = importSheet({
      csv: decide(renderCsv([oneClaim])),
      answers: [JSON.parse(original) as GradedAnswer],
      grader: 'Daniel',
      gradedAt: '2026-11-17',
    })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    writeFileSync(file, `${JSON.stringify(imported.answers[0], null, 2)}\n`)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as GradedAnswer
    expect(saved.grade).toEqual(oneClaim.grade)
    expect(saved.personGrade?.reviewed).toBe(true)
    expect(saved.personGrade?.grader).toBe('Daniel')
  })
})

describe('agreement maths', () => {
  it('matches the worked Cohen kappa of 0.4', () => {
    // Synthetic raters, labels 1 and 0. 20 + 15 agreements out of 50.
    // Expected agreement is 0.5, so kappa is (0.7 - 0.5) / (1 - 0.5) = 0.4.
    const pairs = [
      ...Array.from({ length: 20 }, () => ({ gold: 1, judge: 1 })),
      ...Array.from({ length: 5 }, () => ({ gold: 1, judge: 0 })),
      ...Array.from({ length: 10 }, () => ({ gold: 0, judge: 1 })),
      ...Array.from({ length: 15 }, () => ({ gold: 0, judge: 0 })),
    ]
    const stats = cohensKappa(pairs, [0, 1])
    expect(stats.n).toBe(50)
    expect(stats.matches).toBe(35)
    expect(stats.agreement).toBeCloseTo(0.7)
    expect(stats.percentAgreement).toBeCloseTo(70)
    expect(stats.kappa).toBeCloseTo(0.4)
    expect(stats.confusion).toEqual([
      [15, 10],
      [5, 20],
    ])
  })

  it('is 1 when labels vary and every item matches, and undefined when they do not vary', () => {
    const perfect = cohensKappa([
      { gold: 0, judge: 0 },
      { gold: 2, judge: 2 },
    ])
    expect(perfect.kappa).toBeCloseTo(1)
    expect(perfect.percentAgreement).toBe(100)

    const noVariation = cohensKappa([
      { gold: 2, judge: 2 },
      { gold: 2, judge: 2 },
    ])
    expect(noVariation.agreement).toBe(1)
    expect(noVariation.kappa).toBeNull()

    expect(cohensKappa([]).agreement).toBeNull()
    expect(cohensKappa([]).kappa).toBeNull()
  })

  it('uses the same matches as the model-judge agreement helper', () => {
    const pairs = [
      {
        gold: { faithfulness: 1.8, completeness: 2 },
        judge: { faithfulness: 2, completeness: 2 },
      },
      {
        gold: { faithfulness: 2, completeness: 1 },
        judge: { faithfulness: 0, completeness: 2 },
      },
      {
        gold: { faithfulness: null, completeness: 2 },
        judge: { faithfulness: null, completeness: 2 },
      },
    ]
    const stats = judgePersonAgreement(pairs)
    const legacy = agreement(
      pairs.map((pair) => ({
        human: pair.gold,
        judge: {
          samples: 1,
          faithfulness: pair.judge.faithfulness,
          completeness: pair.judge.completeness,
          spread: { faithfulness: 0, completeness: 0 },
          verdicts: [],
        } satisfies JudgeScore,
      })),
    )
    expect(stats.faithfulness.n).toBe(2)
    expect(stats.faithfulness.agreement).toBeCloseTo(0.5)
    expect(stats.completeness.agreement).toBeCloseTo(2 / 3)
    expect(legacy.faithfulness).toBeCloseTo(stats.faithfulness.agreement!)
    expect(legacy.completeness).toBeCloseTo(stats.completeness.agreement!)
  })

  it('reports draft-vs-person agreement for a synthetic sheet', () => {
    const result = importSheet({
      csv: decide(renderCsv(sample), {
        'synthetic-two': {
          agree: 'disagree',
          person_faithfulness: '0,0',
          person_completeness: '0',
          notes: 'synthetic disagreement',
        },
      }),
      answers: sample,
      grader: 'Daniel',
      gradedAt: '2026-11-17',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.faithfulness.n).toBe(2)
    expect(result.faithfulness.matches).toBe(1)
    expect(result.completeness.matches).toBe(2)
    expect(result.completeness.n).toBe(3)
    expect(result.report).toContain("Cohen's kappa")
    expect(result.report).toContain('| person \\ draft | 0 | 1 | 2 |')
    expect(result.report).toContain('synthetic disagreement')
    expect(result.report).toContain('synthetic-two')
    expect(result.claims.n).toBe(1 + 2)
  })
})

describe('gold labels', () => {
  it('prefers a reviewed person grade over the draft', () => {
    const person: Grade = {
      claims: [],
      completeness: 0,
      grader: 'Daniel',
      reviewed: true,
      gradedAt: '2026-11-17',
    }
    const answer = synthetic(
      'synthetic-gold',
      { claims: [], completeness: 2 },
      {
        personGrade: person,
      },
    )
    expect(referenceGrade(answer)).toBe(person)
    expect(
      referenceGrade(
        synthetic('synthetic-gold', { claims: [], completeness: 2 }),
      ),
    ).toBeNull()
    expect(
      referenceGrade(
        synthetic('synthetic-gold', { claims: [], completeness: 2 }),
        {
          includeDrafts: true,
        },
      )?.grader,
    ).toBe('Claude (draft)')
    const reviewedDraft = synthetic('synthetic-gold', {
      claims: [],
      completeness: 1,
      reviewed: true,
      grader: 'someone',
    })
    expect(referenceGrade(reviewedDraft)?.completeness).toBe(1)
    expect(isClaudeDraft(reviewedDraft)).toBe(false)
  })
})

describe('the drafted sample', () => {
  it('exports every unreviewed Claude draft, and the current sample has 29', () => {
    const drafts = loadDrafts(join(import.meta.dirname, '../../eval/graded'))
    expect(drafts).toHaveLength(29)
    expect(new Set(drafts.map((draft) => draft.answer.questionId)).size).toBe(
      29,
    )
    expect(drafts.every((draft) => isClaudeDraft(draft.answer))).toBe(true)
    const parsed = parseReviewCsv(
      renderCsv(drafts.map((draft) => draft.answer)),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(
      parsed.rows.every(
        (row) =>
          row.agree === '' &&
          row.person_faithfulness === '' &&
          row.person_completeness === '' &&
          row.notes === '',
      ),
    ).toBe(true)
  })
})
