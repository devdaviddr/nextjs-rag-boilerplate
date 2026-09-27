import { describe, expect, it } from 'vitest'

import { faithfulnessOf } from '../../eval/graded-types'
import {
  aggregate,
  agreement,
  judgeBySlice,
  judgeUserMessage,
  parseJudge,
} from '../../eval/judge'

// The model judge (#120) and the graded sample it is measured against (#119).

describe('parseJudge', () => {
  it('reads claims and completeness, dropping what does not fit', () => {
    expect(
      parseJudge(
        'Here: {"claims": [{"sentence": 2, "faithfulness": 1}, {"sentence": 1, "faithfulness": "2"}, {"sentence": 9, "faithfulness": 0}, {"sentence": 1, "faithfulness": 0}, {"sentence": 3, "faithfulness": 5}], "completeness": 2}',
        3,
      ),
    ).toEqual({
      claims: [
        { sentence: 1, faithfulness: 2 },
        { sentence: 2, faithfulness: 1 },
      ],
      completeness: 2,
    })
  })

  it('reads sentence numbers written as "S1"', () => {
    expect(
      parseJudge(
        '{"claims":[{"sentence":"S1","faithfulness":2}],"completeness":2}',
        1,
      ),
    ).toEqual({ claims: [{ sentence: 1, faithfulness: 2 }], completeness: 2 })
  })

  it('has no verdict without a completeness or a claims list', () => {
    expect(parseJudge('{"claims": []}', 2)).toBeNull()
    expect(parseJudge('{"completeness": 1}', 2)).toBeNull()
    expect(parseJudge('no json', 2)).toBeNull()
    expect(parseJudge(undefined, 2)).toBeNull()
  })
})

describe('aggregate', () => {
  it('keeps the median of the usable samples, and their spread', () => {
    const v = (f: 0 | 1 | 2, c: 0 | 1 | 2) => ({
      claims: [{ sentence: 1, faithfulness: f }],
      completeness: c,
    })
    const score = aggregate([v(2, 2), v(1, 2), null, v(2, 1)])
    expect(score).toMatchObject({
      samples: 3,
      faithfulness: 2,
      completeness: 2,
      spread: { faithfulness: 1, completeness: 1 },
    })
  })

  it('has no faithfulness when no sample graded a claim', () => {
    expect(aggregate([{ claims: [], completeness: 2 }])).toMatchObject({
      faithfulness: null,
      completeness: 2,
    })
  })
})

describe('agreement', () => {
  const judge = (f: number | null, c: number) =>
    aggregate([
      {
        claims:
          f === null ? [] : [{ sentence: 1, faithfulness: f as 0 | 1 | 2 }],
        completeness: c as 0 | 1 | 2,
      },
    ])

  it('counts exact matches, faithfulness rounded to a grade', () => {
    expect(
      agreement([
        { human: { faithfulness: 1.8, completeness: 2 }, judge: judge(2, 2) },
        { human: { faithfulness: 2, completeness: 1 }, judge: judge(0, 2) },
        {
          human: { faithfulness: null, completeness: 2 },
          judge: judge(null, 2),
        },
      ]),
    ).toEqual({ answers: 3, faithfulness: 0.5, completeness: 0.667 })
  })
})

describe('graded answers', () => {
  it('scores faithfulness as the mean claim grade', () => {
    expect(
      faithfulnessOf({
        claims: [
          { sentence: 1, text: 'a', faithfulness: 2 },
          { sentence: 2, text: 'b', faithfulness: 1 },
        ],
        completeness: 2,
        grader: 'x',
        reviewed: true,
        gradedAt: '2026-09-27',
      }),
    ).toBe(1.5)
  })

  it('shows the judge numbered sources and sentences', () => {
    const text = judgeUserMessage({
      question: 'How long?',
      answer: 'It is 2.8 degrees [1]. It was set in March [1].',
      sources: [{ id: 'c1', document: 'manual', page: 1, content: 'Text.' }],
    })
    expect(text).toContain('[1] manual, page 1:\nText.')
    expect(text).toContain('S1: It is 2.8 degrees [1].')
    expect(text).toContain('S2: It was set in March [1].')
  })

  it('summarises judge scores per slice', () => {
    const rows = judgeBySlice([
      {
        type: 'layout',
        judge: aggregate([
          { claims: [{ sentence: 1, faithfulness: 2 }], completeness: 1 },
        ]),
      },
      { type: 'layout' },
    ])
    expect(rows.layout).toEqual({
      answers: 1,
      faithfulness: 2,
      completeness: 1,
      unsure: 0,
    })
  })
})
