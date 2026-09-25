import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type RunRecord,
  annotateSpan,
  beginSpan,
  currentRun,
  setRunWriter,
  span,
  startRun,
} from '@/lib/observability/runs'
import { withRequestContext } from '@/lib/observability/context'

/** Spec 0042 FR8: runs and their steps. */

afterEach(() => setRunWriter(null))

/** Run `fn` in a fresh async context, as a request would be. */
function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return withRequestContext({ requestId: 'r' }, fn)
}

describe('outside a run', () => {
  it('just calls the function, and records nothing', async () => {
    await inRequest(async () => {
      expect(await span('x', async () => 42)).toBe(42)
      annotateSpan({ model: 'm', tokens: 3 })
      beginSpan('y').end()
      expect(currentRun()).toBeNull()
    })
  })
})

describe('a run', () => {
  it('nests steps, times them, and credits models and tokens', async () => {
    const written: RunRecord[] = []
    setRunWriter(async (r) => {
      written.push(r)
    })
    await inRequest(async () => {
      const run = startRun({ id: 'run-1', kind: 'question', question: 'q?' })
      await span('retrieve', async (step) => {
        step.set({ mode: 'agentic' })
        await span('plan', async () => {
          annotateSpan({ model: 'planner-m', tokens: 100 })
          annotateSpan({ tokens: 20 })
        })
        await span('search', async (s) => s.set({ results: 5 }))
      })
      const draft = beginSpan('draft')
      draft.end({ model: 'chat-m', tokens: 300 })
      run.finish({ status: 'ok', mode: 'agentic' })
    })
    await vi.waitFor(() => expect(written).toHaveLength(1))

    const run = written[0]!
    expect(run).toMatchObject({
      id: 'run-1',
      status: 'ok',
      totalTokens: 420,
      models: expect.arrayContaining(['planner-m', 'chat-m']),
    })
    const byName = Object.fromEntries(run.spans.map((s) => [s.name, s]))
    expect(byName.retrieve!.parentKey).toBeNull()
    expect(byName.plan!.parentKey).toBe(byName.retrieve!.key)
    expect(byName.search!.parentKey).toBe(byName.retrieve!.key)
    expect(byName.plan).toMatchObject({ model: 'planner-m', tokens: 120 })
    expect(byName.search!.attributes).toEqual({ results: 5 })
    expect(byName.retrieve!.attributes).toEqual({ mode: 'agentic' })
    // Ordered by when they started, not when they ended.
    expect(run.spans.map((s) => s.name)).toEqual([
      'retrieve',
      'plan',
      'search',
      'draft',
    ])
  })

  it('records a failed step and still throws to the caller', async () => {
    const written: RunRecord[] = []
    setRunWriter(async (r) => {
      written.push(r)
    })
    await inRequest(async () => {
      const run = startRun({ id: 'run-2', kind: 'question' })
      await expect(
        span('search', async () => {
          throw new Error('db down')
        }),
      ).rejects.toThrow('db down')
      const aborted = new Error('stop')
      aborted.name = 'AbortError'
      await expect(
        span('draft', async () => {
          throw aborted
        }),
      ).rejects.toThrow('stop')
      run.finish({ status: 'error', error: 'db down' })
    })
    await vi.waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]!.spans.map((s) => [s.name, s.status])).toEqual([
      ['search', 'error'],
      ['draft', 'cancelled'],
    ])
    expect(written[0]!.spans[0]!.attributes.error).toBe('db down')
  })

  it('finishes once, and a failed write never reaches the request', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const write = vi.fn(async () => {
      throw new Error('db down')
    })
    setRunWriter(write)
    await inRequest(async () => {
      const run = startRun({ id: 'run-3', kind: 'ingest' })
      expect(run.finish({ status: 'ok' })).not.toBeNull()
      expect(run.finish({ status: 'error' })).toBeNull()
    })
    await vi.waitFor(() => expect(error).toHaveBeenCalled())
    expect(write).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})
