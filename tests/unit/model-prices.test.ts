import { describe, expect, it } from 'vitest'

import { formatUsd, parseModelPrices, summariseCost } from '@/lib/model-prices'

// Observability's cost figures (#150).
describe('parseModelPrices', () => {
  it('reads model=price pairs, model names with slashes and dashes included', () => {
    const parsed = parseModelPrices(
      'openai/gpt-4o=5, nvidia/nemotron-3-embed-1b=0,  local=0.25 ',
    )
    expect(parsed.ok && [...parsed.prices]).toEqual([
      ['openai/gpt-4o', 5],
      ['nvidia/nemotron-3-embed-1b', 0],
      ['local', 0.25],
    ])
  })

  it('treats unset or blank as no prices', () => {
    expect(parseModelPrices(undefined)).toEqual({ ok: true, prices: new Map() })
    expect(parseModelPrices(' ')).toEqual({ ok: true, prices: new Map() })
  })

  it('names the first entry it cannot read', () => {
    expect(parseModelPrices('gpt=5, broken')).toEqual({
      ok: false,
      error: '"broken" is not model=price (dollars per million tokens)',
    })
    expect(parseModelPrices('gpt=-1').ok).toBe(false)
    expect(parseModelPrices('=5').ok).toBe(false)
  })
})

describe('summariseCost', () => {
  const prices = new Map([
    ['chat', 2],
    ['embed', 0],
  ])

  it('prices each model and never counts an unpriced one as free', () => {
    const cost = summariseCost(
      [
        { model: 'chat', tokens: 500_000 },
        { model: 'chat', tokens: 250_000 },
        { model: 'embed', tokens: 1_000 },
        { model: 'planner', tokens: 4_000 },
        { model: null, tokens: null },
      ],
      prices,
    )
    expect(cost.usd).toBeCloseTo(1.5)
    expect(cost.pricedTokens).toBe(751_000)
    expect(cost.unpricedTokens).toBe(4_000)
    expect(cost.byModel.map((m) => [m.model, m.usd])).toEqual([
      ['chat', 1.5],
      ['planner', null],
      ['embed', 0],
    ])
  })

  it('has no dollar figure when nothing was priced', () => {
    expect(summariseCost([{ model: 'x', tokens: 10 }], prices).usd).toBeNull()
  })
})

describe('formatUsd', () => {
  it('shows a fraction of a cent, and dollars to the cent', () => {
    expect(formatUsd(null)).toBe('–')
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.00123)).toBe('$0.0012')
    expect(formatUsd(12.345)).toBe('$12.35')
  })
})
