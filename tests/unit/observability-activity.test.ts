import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LogRecord } from '@/lib/logger'
import {
  plainLine,
  toActivityLine,
  worthShowing,
} from '@/lib/observability/activity'
import {
  type BusEvent,
  hasListeners,
  publish,
  subscribe,
} from '@/lib/observability/bus'
import { withRequestContext } from '@/lib/observability/context'
import { publishLine } from '@/lib/observability/log-store'
import { REDACTED } from '@/lib/observability/redact'
import { span, startRun } from '@/lib/observability/runs'

/** Spec 0042 FR12: live activity in the chat. */

const unsubscribers: (() => void)[] = []
function listen(requestId: string): BusEvent[] {
  const seen: BusEvent[] = []
  unsubscribers.push(subscribe(requestId, (e) => seen.push(e)))
  return seen
}
afterEach(() => {
  while (unsubscribers.length) unsubscribers.pop()!()
})

describe('the bus', () => {
  it('delivers to the request’s listeners only, until they leave', () => {
    const a = listen('req-a')
    const b = listen('req-b')
    const event: BusEvent = {
      kind: 'log',
      time: 't',
      level: 'info',
      category: 'agent',
      message: 'hello',
      meta: {},
    }
    publish('req-a', event)
    expect(a).toEqual([event])
    expect(b).toEqual([])

    unsubscribers.shift()!()
    expect(hasListeners('req-a')).toBe(false)
    publish('req-a', event)
    expect(a).toHaveLength(1)
  })

  it('never lets a failing listener reach the publisher or the others', () => {
    unsubscribers.push(
      subscribe('req-c', () => {
        throw new Error('broken listener')
      }),
    )
    const good = listen('req-c')
    expect(() =>
      publish('req-c', {
        kind: 'step',
        phase: 'start',
        key: 1,
        parentKey: null,
        name: 'x',
        offsetMs: 0,
      }),
    ).not.toThrow()
    expect(good).toHaveLength(1)
  })
})

describe('plain lines', () => {
  it('turns the agent’s log lines into sentences', () => {
    expect(
      plainLine('Planner chose to search', { query: 'leave policy' }),
    ).toBe('Decided to search for “leave policy”')
    expect(
      plainLine('Search found 3 passages', {
        results: 3,
        bestSimilarity: 0.641,
        query: 'leave',
      }),
    ).toBe('Found 3 passages (best match 0.64) for “leave”')
    expect(plainLine('Search found 0 passages', { results: 0 })).toBe(
      'Found nothing',
    )
    expect(plainLine('Planner chose to answer', {})).toBe(
      'Decided it had found enough to answer',
    )
    expect(
      plainLine('Agentic planner unavailable', {
        reason: 'planner call threw',
        errorMessage: 'Loop time budget exhausted',
      }),
    ).toBe('The planner ran out of time before deciding')
    expect(
      plainLine('Agentic planner unavailable', {
        reason:
          'planner unavailable before searching; falling back to one search',
      }),
    ).toBe('Carried on without the planner: one plain search instead')
  })

  it('keeps any other message as it is, and hides the raw trace', () => {
    expect(plainLine('Document ingested', {})).toBe('Document ingested')
    expect(worthShowing('Agentic trace')).toBe(false)
    expect(worthShowing('Planner chose to search')).toBe(true)
  })

  it('gives details to admins only', () => {
    const line = {
      time: 't',
      level: 'info' as const,
      category: 'agent',
      message: 'Planner chose to search',
      meta: { query: 'q', tokens: 12 },
    }
    expect(toActivityLine(line, false)).not.toHaveProperty('detail')
    expect(toActivityLine(line, true).detail).toEqual({
      message: 'Planner chose to search',
      query: 'q',
      tokens: 12,
    })
  })
})

describe('what gets published', () => {
  it('announces each step as it starts and ends, with its timing', async () => {
    const seen = listen('run-live')
    await withRequestContext({ requestId: 'run-live' }, async () => {
      startRun({ id: 'run-live', kind: 'question' })
      await span('retrieve', async () => {
        await span('search', async () => {})
      })
    })
    expect(
      seen.map((e) => (e.kind === 'step' ? `${e.phase}:${e.name}` : e.kind)),
    ).toEqual(['start:retrieve', 'start:search', 'end:search', 'end:retrieve'])
    const end = seen.find(
      (e) => e.kind === 'step' && e.phase === 'end' && e.name === 'search',
    )
    expect(end).toMatchObject({ status: 'ok', parentKey: 1 })
  })

  it('publishes a log line categorised and with secrets removed', () => {
    const seen = listen('req-log')
    const record: LogRecord = {
      level: 'warn',
      message: 'Inference request retrying',
      time: new Date('2026-09-26T00:00:00Z'),
      context: { requestId: 'req-log' },
      meta: { status: 503, apiKey: 'sk-live-123456789' },
    }
    publishLine(record)
    expect(seen).toEqual([
      expect.objectContaining({
        kind: 'log',
        level: 'warn',
        category: 'inference',
        meta: { status: 503, apiKey: REDACTED },
      }),
    ])
  })

  it('does no work for a request nobody is watching', () => {
    const spy = vi.fn()
    unsubscribers.push(subscribe('someone-else', spy))
    publishLine({
      level: 'info',
      message: 'x',
      time: new Date(),
      context: { requestId: 'unwatched' },
      meta: {},
    })
    expect(spy).not.toHaveBeenCalled()
  })
})
