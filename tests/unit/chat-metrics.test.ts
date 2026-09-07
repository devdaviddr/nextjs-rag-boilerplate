import { describe, expect, it } from 'vitest'

import {
  computeMetrics,
  formatMetrics,
  shortModelName,
} from '@/lib/chat/metrics'

const base = {
  model: 'nvidia/nemotron-3-super-120b-a12b',
  startedAt: 1_000,
  firstTokenAt: 2_000,
  finishedAt: 6_000,
  sourceCount: 3,
  retrieval: 'search' as const,
}

describe('computeMetrics', () => {
  it('measures the generation window, excluding time to first token', () => {
    // 100 tokens over the 4s between first and last token — not over the
    // 5s total, which would understate the model's actual rate.
    const m = computeMetrics({ ...base, completionTokens: 100 })
    expect(m.tokensPerSecond).toBe(25)
    expect(m.timeToFirstTokenMs).toBe(1_000)
    expect(m.totalMs).toBe(5_000)
  })

  it('reports null rather than a guess when the provider omits usage', () => {
    const m = computeMetrics({ ...base, completionTokens: null })
    expect(m.completionTokens).toBeNull()
    expect(m.tokensPerSecond).toBeNull()
    // Wall-clock timings are still ours to measure.
    expect(m.totalMs).toBe(5_000)
  })

  it('does not divide by zero when the answer arrives in one instant', () => {
    const m = computeMetrics({
      ...base,
      firstTokenAt: 6_000,
      completionTokens: 40,
    })
    expect(m.tokensPerSecond).toBeNull()
    expect(Number.isFinite(m.totalMs)).toBe(true)
  })

  it('handles never receiving a token at all', () => {
    const m = computeMetrics({
      ...base,
      firstTokenAt: null,
      completionTokens: 0,
    })
    expect(m.timeToFirstTokenMs).toBeNull()
    expect(m.tokensPerSecond).toBeNull()
  })
})

describe('shortModelName', () => {
  it('drops the vendor prefix', () => {
    expect(shortModelName('nvidia/nemotron-3-super-120b-a12b')).toBe(
      'nemotron-3-super-120b-a12b',
    )
  })
  it('leaves an unprefixed name alone', () => {
    expect(shortModelName('gpt-oss')).toBe('gpt-oss')
  })
})

describe('formatMetrics', () => {
  it('renders the full set in a readable order', () => {
    const parts = formatMetrics(
      computeMetrics({ ...base, completionTokens: 100 }),
    )
    expect(parts).toEqual([
      '100 tokens',
      '25 tok/s',
      '1.0s to first token',
      '5.0s total',
      '3 sources',
      'similarity search',
      'nemotron-3-super-120b-a12b',
    ])
  })

  it('omits what it does not know instead of showing zeroes', () => {
    const parts = formatMetrics(
      computeMetrics({ ...base, completionTokens: null, firstTokenAt: null }),
    )
    expect(parts.some((p) => p.includes('tok/s'))).toBe(false)
    expect(parts.some((p) => p.includes('first token'))).toBe(false)
    expect(parts).toContain('5.0s total')
  })

  it('uses milliseconds below a second, and singular for one source', () => {
    const parts = formatMetrics(
      computeMetrics({
        ...base,
        firstTokenAt: 1_400,
        finishedAt: 1_900,
        completionTokens: 5,
        sourceCount: 1,
        retrieval: 'document',
      }),
    )
    expect(parts).toContain('400ms to first token')
    expect(parts).toContain('1 source')
    expect(parts).toContain('whole document')
  })
})
