import { describe, expect, it } from 'vitest'

import {
  citedIndices,
  parseVerdict,
  splitSentences,
  stripUnsupported,
} from '@/lib/rag/verify'

describe('splitSentences', () => {
  it('keeps trailing punctuation with its sentence', () => {
    expect(splitSentences('One. Two! Three?')).toEqual([
      'One.',
      ' Two!',
      ' Three?',
    ])
  })

  it('returns an empty list for empty input', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('   ')).toEqual([])
  })
})

describe('citedIndices', () => {
  it('reads one or several markers', () => {
    expect(citedIndices('The entitlement is 20 days [1].')).toEqual([1])
    expect(citedIndices('Both agree [2][3].')).toEqual([2, 3])
  })

  it('deduplicates repeated markers', () => {
    expect(citedIndices('As noted [1] and again [1].')).toEqual([1])
  })

  it('returns nothing for uncited prose', () => {
    expect(citedIndices('Here is what I found:')).toEqual([])
  })
})

describe('stripUnsupported', () => {
  const answer =
    'The entitlement is 20 working days [1]. Parking is on Wellington Street [2]. That is all.'

  it('returns the answer untouched when nothing is unsupported', () => {
    const result = stripUnsupported(answer, [])
    expect(result.text).toBe(answer)
    expect(result.strippedIndices).toEqual([])
    expect(result.empty).toBe(false)
  })

  it('removes only the sentence whose citation was unsupported', () => {
    const result = stripUnsupported(answer, [2])
    expect(result.text).toContain('20 working days [1]')
    expect(result.text).not.toContain('Wellington Street')
    expect(result.strippedIndices).toEqual([2])
    expect(result.empty).toBe(false)
  })

  /**
   * Stripping a sentence that still has a supported source behind it would
   * discard a correct claim — a worse outcome than leaving a partly-shaky one.
   */
  it('keeps a sentence when only some of its citations are unsupported', () => {
    const result = stripUnsupported('Both documents agree [2][3].', [3])
    expect(result.text).toBe('Both documents agree [2][3].')
    expect(result.strippedIndices).toEqual([])
  })

  it('keeps uncited connective prose alongside a surviving claim', () => {
    const result = stripUnsupported(
      'Here is what I found. The rule is X [1]. Parking is on Wellington Street [2].',
      [2],
    )
    expect(result.text).toContain('Here is what I found.')
    expect(result.text).toContain('The rule is X [1].')
    expect(result.text).not.toContain('Wellington Street')
    expect(result.empty).toBe(false)
  })

  /**
   * Connective prose with every claim removed is not an answer. The caller must
   * refuse rather than show it — the fourth refusal entry point.
   */
  it('reports empty when the prose survives but every claim was stripped', () => {
    const result = stripUnsupported(
      'Here is what I found. The rule is X [1].',
      [1],
    )
    expect(result.text).toBe('Here is what I found.')
    expect(result.empty).toBe(true)
  })

  /**
   * A claim and its connective lead-in in ONE sentence go together — there is
   * no supported fragment left to keep, so the whole sentence goes.
   */
  it('strips a whole sentence when its lead-in and only claim share it', () => {
    const result = stripUnsupported(
      'Here is what I found: the rule is X [1].',
      [1],
    )
    expect(result.text).toBe('')
    expect(result.empty).toBe(true)
  })

  it('reports empty for an answer that was entirely unsupported', () => {
    const result = stripUnsupported('The rule is X [1]. And Y [2].', [1, 2])
    expect(result.text).toBe('')
    expect(result.empty).toBe(true)
    expect(result.strippedIndices).toEqual([1, 2])
  })
})

describe('parseVerdict', () => {
  it('reads a list of unsupported indices', () => {
    expect(parseVerdict('{"unsupported":[2,3]}')).toEqual([2, 3])
  })

  it('reads JSON after a reasoning preamble', () => {
    expect(
      parseVerdict('Let me check each source.\n{"unsupported": [1]}'),
    ).toEqual([1])
  })

  it('coerces numeric strings and drops nonsense entries', () => {
    expect(parseVerdict('{"unsupported":["2","x",0,-1,3.5,4]}')).toEqual([2, 4])
  })

  /**
   * Fails OPEN, deliberately. The similarity floor is the gate on whether an
   * answer may be shown, and it has already run. A flaky verification call must
   * not be able to turn a correctly-grounded answer into a refusal.
   */
  it.each([
    ['null content', null],
    ['empty content', ''],
    ['prose with no JSON', 'I could not determine this.'],
    ['malformed JSON', '{"unsupported": [1,'],
    ['a non-object', '[1,2]'],
    ['a missing key', '{"supported":[1]}'],
    ['a non-array value', '{"unsupported":"all of them"}'],
  ])('returns an empty list for %s', (_label, input) => {
    expect(parseVerdict(input as string | null)).toEqual([])
  })
})
