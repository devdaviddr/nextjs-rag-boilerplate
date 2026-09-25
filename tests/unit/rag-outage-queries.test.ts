import { describe, expect, it } from 'vitest'

import {
  OUTAGE_CONTEXT_CHARS,
  outageQueries,
  previousUserTurn,
} from '@/lib/rag/rewrite'

/**
 * #41 — what the agentic loop searches when the planner is down. The literal
 * question must always come first, so a question that stands on its own keeps
 * exactly the fallback it had before this change.
 */
describe('outageQueries', () => {
  it('is just the question when there is no earlier user turn', () => {
    expect(outageQueries('How much leave do I get?', [])).toEqual([
      'How much leave do I get?',
    ])
    expect(
      outageQueries('q', [{ role: 'assistant', content: 'Hello!' }]),
    ).toEqual(['q'])
  })

  it('adds a variant carrying the most recent user turn', () => {
    expect(
      outageQueries('what about sweden central?', [
        { role: 'user', content: 'what regions exist?' },
        { role: 'assistant', content: 'Several regions are listed...' },
        { role: 'user', content: 'can i tune a model in australia south east' },
        { role: 'assistant', content: 'Yes, fine-tuning is available there.' },
      ]),
    ).toEqual([
      'what about sweden central?',
      'can i tune a model in australia south east what about sweden central?',
    ])
  })

  it('never carries assistant text, and bounds the carried context', () => {
    const long = 'x'.repeat(OUTAGE_CONTEXT_CHARS + 200)
    const [, withContext] = outageQueries('and then?', [
      { role: 'user', content: long },
      { role: 'assistant', content: 'SECRET ASSISTANT WORDING' },
    ])
    expect(withContext).not.toContain('SECRET')
    expect(withContext).toBe(`${'x'.repeat(OUTAGE_CONTEXT_CHARS)} and then?`)
  })

  it('skips an empty user turn', () => {
    expect(
      outageQueries('q', [
        { role: 'user', content: 'earlier' },
        { role: 'user', content: '   ' },
      ]),
    ).toEqual(['q', 'earlier q'])
  })

  it('exposes the same previous turn as the yardstick', () => {
    expect(previousUserTurn([])).toBeNull()
    expect(
      previousUserTurn([
        { role: 'user', content: '  How long is probation?  ' },
        { role: 'assistant', content: 'Six months.' },
      ]),
    ).toBe('How long is probation?')
  })
})
