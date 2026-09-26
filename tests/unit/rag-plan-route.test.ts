import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { planRoute } from '@/lib/rag/plan-route'
import type { RewriteTurn } from '@/lib/rag/rewrite'

/** Spec 0043 NFR1: the router, checked against every eval question. */

interface EvalQuestion {
  id: string
  type: string
  question: string
  turns?: RewriteTurn[]
}

const questions = (
  JSON.parse(
    readFileSync(join(process.cwd(), 'eval/questions.json'), 'utf8'),
  ) as { questions: EvalQuestion[] }
).questions

const byType = (type: string) => questions.filter((q) => q.type === type)

describe('planRoute on the eval set', () => {
  it('sends every follow-up to the planner', () => {
    const missed = byType('followup').filter(
      (q) => !planRoute(q.question, q.turns ?? []).plan,
    )
    expect(missed.map((q) => q.question)).toEqual([])
    expect(byType('followup').length).toBeGreaterThanOrEqual(20)
  })

  it('sends every multi-part question to the planner', () => {
    const missed = byType('multi-hop').filter(
      (q) => !planRoute(q.question, q.turns ?? []).plan,
    )
    expect(missed.map((q) => q.question)).toEqual([])
  })

  it('sends every standalone single-hop question straight to search', () => {
    const planned = byType('single-hop').filter(
      (q) => planRoute(q.question, q.turns ?? []).plan,
    )
    expect(planned.map((q) => q.question)).toEqual([])
  })
})

describe('planRoute', () => {
  const history: RewriteTurn[] = [
    { role: 'user', content: 'How many days of annual leave do I get?' },
    { role: 'assistant', content: '20 working days per year.' },
  ]

  it('names why', () => {
    expect(planRoute('Can I carry it over?', history)).toEqual({
      plan: true,
      reason: 'follow-up',
    })
    expect(
      planRoute('How long is probation, and what notice applies?', []),
    ).toEqual({ plan: true, reason: 'multi-part' })
    expect(planRoute('Where can staff park?', [])).toEqual({
      plan: false,
      reason: 'standalone',
    })
  })

  it('treats a new, complete question mid-conversation as standalone', () => {
    expect(
      planRoute('What is the policy on working from home on Fridays?', history)
        .plan,
    ).toBe(false)
  })

  it('treats a temporal back-reference as a follow-up (#106)', () => {
    for (const q of [
      'How long does the fire watch stay afterwards?',
      'When does the report come out afterward?',
      'What do I need to do beforehand?',
      'Who covers the desk in the meantime, meanwhile?',
    ]) {
      expect(planRoute(q, history)).toEqual({ plan: true, reason: 'follow-up' })
    }
    // With no conversation there is nothing to point back at.
    expect(
      planRoute('How long does the fire watch stay afterwards?', []).plan,
    ).toBe(false)
  })

  it('treats corrections and short replies as follow-ups', () => {
    expect(planRoute('No, I meant the night shift rate.', history).plan).toBe(
      true,
    )
    expect(planRoute('And planned?', history).plan).toBe(true)
    // Without a conversation there is nothing to follow up on.
    expect(planRoute('And planned?', []).plan).toBe(false)
  })
})
