import { describe, expect, it } from 'vitest'

import { readVerdict } from '@/lib/rag/verify'
import {
  formatPrecision,
  precisionBySlice,
  precisionRow,
  scoreVerification,
} from '../../eval/precision'

// Citation precision in rag:eval --answers (#118).

const ANSWER =
  'Staff get 25 days of annual leave [1]. Leave carries over for a year [2]. Ask your manager first.'

describe('readVerdict', () => {
  it('tells "no verdict" apart from "all supported"', () => {
    expect(readVerdict('{"unsupported": []}')).toEqual([])
    expect(readVerdict('{"unsupported": [2]}')).toEqual([2])
    expect(readVerdict('')).toBeNull()
    expect(readVerdict('I think it is fine.')).toBeNull()
    expect(readVerdict('{"verdict": "ok"}')).toBeNull()
  })
})

describe('scoreVerification', () => {
  it('counts sentences, cited sentences and the unsupported among them', () => {
    expect(scoreVerification(ANSWER, [2, 3])).toEqual({
      status: 'ok',
      sentences: 3,
      cited: 2,
      unsupported: [2, 3],
      unsupportedCited: 1,
    })
  })

  it('ignores sentence numbers the answer does not have', () => {
    expect(scoreVerification(ANSWER, [9]).unsupported).toEqual([])
  })

  it('marks a missing verdict', () => {
    expect(scoreVerification(ANSWER, null)).toMatchObject({
      status: 'none',
      unsupported: [],
    })
  })
})

describe('precision rows', () => {
  const items = [
    { type: 'single-hop', verification: scoreVerification(ANSWER, [2]) },
    { type: 'single-hop', verification: scoreVerification(ANSWER, []) },
    { type: 'layout', verification: scoreVerification(ANSWER, null) },
    { type: 'layout' },
  ]

  it('leaves answers with no verdict out of the rates, and counts them', () => {
    expect(precisionRow(items)).toEqual({
      answers: 3,
      noVerdict: 1,
      sentences: 6,
      unsupported: 1,
      supportRate: 0.833,
      cited: 4,
      unsupportedCited: 1,
      citationPrecision: 0.75,
    })
  })

  it('reports per slice and pooled, and prints a row for each', () => {
    const rows = precisionBySlice(items)
    expect(Object.keys(rows)).toEqual(['layout', 'single-hop', 'all'])
    expect(rows.layout).toMatchObject({
      answers: 1,
      noVerdict: 1,
      supportRate: null,
    })
    expect(formatPrecision(rows)).toHaveLength(4)
  })
})
