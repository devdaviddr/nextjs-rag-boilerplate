import { describe, expect, it, vi } from 'vitest'

import {
  type LoopBudget,
  type LoopDeps,
  accumulate,
  effectiveFloor,
  runAgenticLoop,
} from '@/lib/rag/agentic'
import type { RetrievedChunk } from '@/lib/rag/retrieve'

function chunk(id: string, similarity: number): RetrievedChunk {
  return {
    chunkId: id,
    documentId: 'doc-1',
    documentTitle: 'handbook',
    content: `content ${id}`,
    pageNumber: 1,
    similarity,
  } as RetrievedChunk
}

const BUDGET: LoopBudget = { maxSearches: 3, maxMs: 15000, maxTokens: 8000 }

function deps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    plan: vi
      .fn()
      .mockResolvedValue({ decision: { action: 'answer' }, tokens: 10 }),
    search: vi.fn().mockResolvedValue([]),
    ...over,
  }
}

const signal = new AbortController().signal

describe('accumulate', () => {
  it('deduplicates by chunk id, keeping the best score', () => {
    const merged = accumulate(
      [chunk('a', 0.4)],
      [chunk('a', 0.7), chunk('b', 0.5)],
    )
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ chunkId: 'a', similarity: 0.7 })
    expect(merged[1]).toMatchObject({ chunkId: 'b', similarity: 0.5 })
  })

  it('orders by similarity, best first', () => {
    const merged = accumulate(
      [],
      [chunk('a', 0.2), chunk('b', 0.9), chunk('c', 0.5)],
    )
    expect(merged.map((c) => c.chunkId)).toEqual(['b', 'c', 'a'])
  })
})

describe('runAgenticLoop — termination', () => {
  it('stops when the planner chooses to answer, without searching', async () => {
    const d = deps()
    const out = await runAgenticLoop(BUDGET, d, signal)
    expect(out.termination).toBe('planner-answered')
    expect(out.searches).toBe(0)
    expect(d.search).not.toHaveBeenCalled()
  })

  it('stops when the planner chooses to refuse', async () => {
    const out = await runAgenticLoop(
      BUDGET,
      deps({
        plan: vi.fn().mockResolvedValue({
          decision: { action: 'refuse' },
          tokens: 5,
        }),
      }),
      signal,
    )
    expect(out.termination).toBe('planner-refused')
  })

  it('searches, then answers on the second decision', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce({
        decision: { action: 'search', query: 'annual leave' },
        tokens: 20,
      })
      .mockResolvedValueOnce({ decision: { action: 'answer' }, tokens: 15 })
    const search = vi.fn().mockResolvedValue([chunk('a', 0.6)])

    const out = await runAgenticLoop(BUDGET, deps({ plan, search }), signal)
    expect(out.termination).toBe('planner-answered')
    expect(out.searches).toBe(1)
    expect(out.chunks).toHaveLength(1)
    expect(out.tokensUsed).toBe(35)
    expect(out.steps[0]).toMatchObject({
      iteration: 1,
      query: 'annual leave',
      resultCount: 1,
      bestSimilarity: 0.6,
    })
  })
})

describe('runAgenticLoop — budgets', () => {
  /** Each bound must independently terminate the loop (spec 0029 acceptance). */
  it('stops at the search budget when the planner keeps searching', async () => {
    const plan = vi.fn().mockResolvedValue({
      decision: { action: 'search', query: 'again' },
      tokens: 10,
    })
    const search = vi.fn().mockResolvedValue([chunk('a', 0.5)])

    const out = await runAgenticLoop(BUDGET, deps({ plan, search }), signal)
    expect(out.termination).toBe('search-budget')
    expect(out.searches).toBe(3)
    expect(search).toHaveBeenCalledTimes(3)
  })

  it('stops at the time budget', async () => {
    let t = 0
    const out = await runAgenticLoop(
      { ...BUDGET, maxMs: 100 },
      deps({
        // Each planning call "takes" 60ms.
        now: () => (t += 60),
        plan: vi.fn().mockResolvedValue({
          decision: { action: 'search', query: 'again' },
          tokens: 1,
        }),
        search: vi.fn().mockResolvedValue([chunk('a', 0.5)]),
      }),
      signal,
    )
    expect(out.termination).toBe('time-budget')
    expect(out.searches).toBeLessThan(3)
  })

  it('stops at the token budget', async () => {
    const out = await runAgenticLoop(
      { ...BUDGET, maxTokens: 50 },
      deps({
        plan: vi.fn().mockResolvedValue({
          decision: { action: 'search', query: 'again' },
          tokens: 40,
        }),
        search: vi.fn().mockResolvedValue([chunk('a', 0.5)]),
      }),
      signal,
    )
    expect(out.termination).toBe('token-budget')
  })

  /**
   * Budgets are checked before the expensive call, never after — checking
   * afterwards lets each bound be exceeded by exactly one call.
   */
  it('does not exceed the search budget by one', async () => {
    const search = vi.fn().mockResolvedValue([])
    await runAgenticLoop(
      { ...BUDGET, maxSearches: 1 },
      deps({
        plan: vi.fn().mockResolvedValue({
          decision: { action: 'search', query: 'q' },
          tokens: 1,
        }),
        search,
      }),
      signal,
    )
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('keeps whatever it gathered when a budget cuts it short', async () => {
    const out = await runAgenticLoop(
      { ...BUDGET, maxSearches: 2 },
      deps({
        plan: vi.fn().mockResolvedValue({
          decision: { action: 'search', query: 'q' },
          tokens: 1,
        }),
        search: vi
          .fn()
          .mockResolvedValueOnce([chunk('a', 0.6)])
          .mockResolvedValueOnce([chunk('b', 0.4)]),
      }),
      signal,
    )
    expect(out.termination).toBe('search-budget')
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['a', 'b'])
  })
})

describe('runAgenticLoop — planner failure', () => {
  it('returns what it has when the planner throws', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce({
        decision: { action: 'search', query: 'leave' },
        tokens: 10,
      })
      .mockRejectedValueOnce(new Error('502 upstream'))

    const out = await runAgenticLoop(
      BUDGET,
      deps({ plan, search: vi.fn().mockResolvedValue([chunk('a', 0.55)]) }),
      signal,
    )
    expect(out.termination).toBe('planner-unavailable')
    expect(out.chunks).toHaveLength(1)
  })

  /**
   * A null decision means the response carried nothing usable. Stopping — not
   * retrying — is what keeps a bounded loop bounded.
   */
  it('stops rather than retrying on an unusable decision', async () => {
    const plan = vi.fn().mockResolvedValue({ decision: null, tokens: 10 })
    const out = await runAgenticLoop(BUDGET, deps({ plan }), signal)
    expect(out.termination).toBe('planner-unavailable')
    expect(plan).toHaveBeenCalledTimes(1)
  })

  it('stops on a search decision with an empty query', async () => {
    const out = await runAgenticLoop(
      BUDGET,
      deps({
        plan: vi.fn().mockResolvedValue({
          decision: { action: 'search', query: '   ' },
          tokens: 1,
        }),
      }),
      signal,
    )
    expect(out.termination).toBe('planner-unavailable')
  })

  it('never composes prose or decides to refuse on its own', async () => {
    // The loop's only outputs are evidence and a reason for stopping. Refusal
    // belongs to the caller, around the loop.
    const out = await runAgenticLoop(BUDGET, deps(), signal)
    expect(Object.keys(out)).toEqual([
      'chunks',
      'termination',
      'steps',
      'searches',
      'tokensUsed',
      'elapsedMs',
    ])
  })
})

describe('effectiveFloor', () => {
  /**
   * One attempt is judged exactly as the fixed pipeline judges it — the whole
   * point is that persistence, not relevance, is what gets penalised.
   */
  it('leaves a single search at the base floor', () => {
    expect(effectiveFloor(0.35, 1, 0.04)).toBeCloseTo(0.35)
    expect(effectiveFloor(0.35, 0, 0.04)).toBeCloseTo(0.35)
  })

  it('raises the bar once per EXTRA search', () => {
    expect(effectiveFloor(0.35, 2, 0.04)).toBeCloseTo(0.39)
    expect(effectiveFloor(0.35, 3, 0.04)).toBeCloseTo(0.43)
  })

  /**
   * The measured regression: three searches for an unanswerable question
   * surfaced a chunk at 0.421, above the flat 0.35 floor. At three attempts the
   * bar is 0.43, so it is correctly excluded — while a true positive found on
   * the FIRST search at 0.41 still clears the unchanged 0.35.
   */
  it('excludes the chunk that caused the refusal regression', () => {
    expect(0.421).toBeLessThan(effectiveFloor(0.35, 3, 0.04))
    expect(0.41).toBeGreaterThan(effectiveFloor(0.35, 1, 0.04))
  })

  it('is a no-op when the step is zero', () => {
    expect(effectiveFloor(0.35, 5, 0)).toBeCloseTo(0.35)
  })
})

describe('runAgenticLoop — the planner may not answer before searching', () => {
  /**
   * The router already decided this turn needs retrieval, and that decision is
   * deliberately biased towards searching. A planner that then answers with no
   * evidence re-opens the ungrounded-answer hole one layer down — measured on a
   * live endpoint, several questions came back planner-answered with zero
   * searches and zero chunks, which can only become a refusal.
   */
  it('forces one search when the planner answers with no evidence', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce({ decision: { action: 'answer' }, tokens: 10 })
      .mockResolvedValueOnce({ decision: { action: 'answer' }, tokens: 10 })
    const search = vi.fn().mockResolvedValue([chunk('a', 0.6)])
    const onPlanFailure = vi.fn()

    const out = await runAgenticLoop(
      BUDGET,
      deps({
        plan,
        search,
        fallbackQuery: 'the original question',
        onPlanFailure,
      }),
      signal,
    )
    expect(search).toHaveBeenCalledWith('the original question', undefined)
    expect(out.searches).toBe(1)
    expect(out.chunks).toHaveLength(1)
    expect(onPlanFailure).toHaveBeenCalledWith(
      'planner answered before searching; forcing one search',
    )
  })

  it('accepts an answer once evidence exists', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce({
        decision: { action: 'search', query: 'leave' },
        tokens: 10,
      })
      .mockResolvedValueOnce({ decision: { action: 'answer' }, tokens: 10 })
    const out = await runAgenticLoop(
      BUDGET,
      deps({
        plan,
        search: vi.fn().mockResolvedValue([chunk('a', 0.6)]),
        fallbackQuery: 'q',
      }),
      signal,
    )
    expect(out.termination).toBe('planner-answered')
    expect(out.searches).toBe(1)
  })

  it('still honours an explicit refusal', async () => {
    const out = await runAgenticLoop(
      BUDGET,
      deps({
        plan: vi.fn().mockResolvedValue({
          decision: { action: 'refuse' },
          tokens: 5,
        }),
        fallbackQuery: 'q',
      }),
      signal,
    )
    expect(out.termination).toBe('planner-refused')
  })
})
