import { describe, expect, it } from 'vitest'

import {
  citedIndices,
  numberSentences,
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

describe('numberSentences', () => {
  it('puts one numbered sentence on each line', () => {
    expect(
      numberSentences(
        'Here is what I found. Leave is 20 days [1]. It carries over.',
      ),
    ).toBe(
      'S1: Here is what I found.\nS2: Leave is 20 days [1].\nS3: It carries over.',
    )
  })
})

describe('stripUnsupported', () => {
  // Verdicts are sentence numbers (#127): S1, S2, S3 here.
  const answer =
    'The entitlement is 20 working days [1]. Parking is on Wellington Street [2]. That is all.'

  it('returns the answer untouched when nothing is unsupported', () => {
    const result = stripUnsupported(answer, [])
    expect(result.text).toBe(answer)
    expect(result.strippedIndices).toEqual([])
    expect(result.strippedSentences).toBe(0)
    expect(result.empty).toBe(false)
  })

  it('removes only the sentence judged unsupported', () => {
    const result = stripUnsupported(answer, [2])
    expect(result.text).toContain('20 working days [1]')
    expect(result.text).not.toContain('Wellington Street')
    expect(result.strippedIndices).toEqual([2])
    expect(result.strippedSentences).toBe(1)
    expect(result.empty).toBe(false)
  })

  // #127: an uncited claim used to be kept without being checked.
  it('removes an unsupported sentence that cites nothing', () => {
    const result = stripUnsupported(
      'Leave is 20 days [1]. Unused leave carries over indefinitely.',
      [2],
    )
    expect(result.text).toBe('Leave is 20 days [1].')
    expect(result.strippedIndices).toEqual([])
    expect(result.strippedSentences).toBe(1)
    expect(result.empty).toBe(false)
  })

  it('keeps an answer with no citations when its sentences are supported', () => {
    const result = stripUnsupported(
      'Leave is 20 days. Unused leave carries over indefinitely.',
      [2],
    )
    expect(result.text).toBe('Leave is 20 days.')
    expect(result.empty).toBe(false)
  })

  it('keeps uncited connective prose alongside a surviving claim', () => {
    const result = stripUnsupported(
      'Here is what I found. The rule is X [1]. Parking is on Wellington Street [2].',
      [3],
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
  it('reports empty when the prose survives but every cited claim was stripped', () => {
    const result = stripUnsupported(
      'Here is what I found. The rule is X [1].',
      [2],
    )
    expect(result.text).toBe('Here is what I found.')
    expect(result.empty).toBe(true)
  })

  it('reports empty for an answer that was entirely unsupported', () => {
    const result = stripUnsupported('The rule is X [1]. And Y [2].', [1, 2])
    expect(result.text).toBe('')
    expect(result.empty).toBe(true)
    expect(result.strippedIndices).toEqual([1, 2])
    expect(result.strippedSentences).toBe(2)
  })

  it('ignores a sentence number past the end of the answer', () => {
    const result = stripUnsupported('The rule is X [1].', [5])
    expect(result.text).toBe('The rule is X [1].')
    expect(result.strippedSentences).toBe(0)
    expect(result.empty).toBe(false)
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
