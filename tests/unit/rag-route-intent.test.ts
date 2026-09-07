import { describe, expect, it } from 'vitest'

import { routeTurn } from '@/lib/rag/route-intent'

describe('routeTurn — skips retrieval', () => {
  it.each([
    'thanks',
    'Thanks!',
    'thank you',
    'thanks so much',
    '  cheers  ',
    'ok',
    'Okay.',
    'got it',
    'makes sense',
    'perfect',
    'hi',
    'hey there',
    'Good morning',
    'bye',
    'goodbye',
    'see you later',
    'never mind',
    'nvm',
  ])('treats %j as conversational filler', (input) => {
    expect(routeTurn(input)).toBe('answer-directly')
  })

  it.each([
    'what can you do',
    'What can you do?',
    'who are you',
    'how do you work',
    'help',
  ])('treats %j as a meta-question', (input) => {
    expect(routeTurn(input)).toBe('answer-directly')
  })
})

describe('routeTurn — retrieves', () => {
  it.each([
    'how many days of annual leave do I get?',
    'what does POL-HR-014 cover?',
    'summarise the staff handbook',
    'what about carrying it over?',
  ])('retrieves for a real question: %j', (input) => {
    expect(routeTurn(input)).toBe('retrieve')
  })

  /**
   * The whole reason the filler patterns are anchored at both ends. A message
   * that merely STARTS with a pleasantry is still a question, and skipping
   * retrieval for it would produce an ungrounded answer — the exact failure the
   * router must never cause.
   */
  it.each([
    'thanks, now what does the handbook say about leave?',
    'hi, how much annual leave do I get?',
    'ok but what is the notice period',
    'great — where is the fire assembly point',
    'right, tell me about the parking policy',
  ])(
    'does NOT skip retrieval for filler followed by a question: %j',
    (input) => {
      expect(routeTurn(input)).toBe('retrieve')
    },
  )

  it('does not skip retrieval for a question that merely contains a filler word', () => {
    expect(routeTurn('is the parking ok for visitors?')).toBe('retrieve')
    expect(routeTurn('who do I say thanks to for approving leave?')).toBe(
      'retrieve',
    )
  })

  /**
   * Fail towards retrieval. Anything unrecognised, empty or malformed must
   * retrieve rather than be answered from the model's own knowledge.
   */
  it.each(['', '   ', '?', '...', '🙂', 'asdfghjkl'])(
    'falls back to retrieval for unrecognised input %j',
    (input) => {
      expect(routeTurn(input)).toBe('retrieve')
    },
  )
})
