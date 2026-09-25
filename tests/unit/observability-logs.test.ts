import { afterEach, describe, expect, it, vi } from 'vitest'

import { type LogRecord, logger, setLogContext, setLogSink } from '@/lib/logger'
import { categorise } from '@/lib/observability/categorise'
import {
  annotateContext,
  currentContext,
  withRequestContext,
} from '@/lib/observability/context'
import {
  BATCH_SIZE,
  MAX_BUFFER,
  createLogQueue,
  toRow,
} from '@/lib/observability/log-store'
import { REDACTED, redact } from '@/lib/observability/redact'

/** Spec 0042 FR3–FR5, NFR1, NFR2: the log store. */

const record = (
  message: string,
  meta: Record<string, unknown> = {},
  context?: LogRecord['context'],
): LogRecord => ({
  level: 'info',
  message,
  time: new Date('2026-09-26T00:00:00Z'),
  context,
  meta,
})

afterEach(() => {
  setLogSink(null)
  setLogContext(null)
  vi.restoreAllMocks()
})

describe('redact (NFR2)', () => {
  it('replaces secret-named keys, at any depth', () => {
    expect(
      redact({
        apiKey: 'abc',
        nested: { password: 'p', Authorization: 'Bearer x', ok: 'fine' },
        tokens: 42,
        hasKey: true,
      }),
    ).toEqual({
      apiKey: REDACTED,
      nested: { password: REDACTED, Authorization: REDACTED, ok: 'fine' },
      tokens: 42,
      hasKey: true,
    })
  })

  it('replaces values that look like API keys wherever they appear', () => {
    expect(
      redact({ note: 'used nvapi-abcdefghijklmnop and sk-or-v1-12345678' }),
    ).toEqual({ note: `used ${REDACTED} and ${REDACTED}` })
  })

  it('turns errors into plain objects and bounds the size', () => {
    const out = redact({ err: new Error('boom') }) as {
      err: { name: string; message: string }
    }
    expect(out.err).toMatchObject({ name: 'Error', message: 'boom' })
    const long = redact('x'.repeat(10_000)) as string
    expect(long.length).toBeLessThan(4_100)
    expect(
      (redact(Array.from({ length: 500 }, (_, i) => i)) as unknown[]).length,
    ).toBe(101)
  })
})

describe('categorise (FR5)', () => {
  it('uses the category a line names', () => {
    expect(categorise('anything', { category: 'agent' }, undefined)).toBe(
      'agent',
    )
  })

  it('infers one from the message for lines written before categories', () => {
    expect(categorise('Agentic planner unavailable', {}, undefined)).toBe(
      'agent',
    )
    expect(categorise('Inference request retrying', {}, undefined)).toBe(
      'inference',
    )
    expect(
      categorise('rerank failed, keeping fusion order', {}, undefined),
    ).toBe('retrieval')
    expect(categorise('Page cracking failed', {}, undefined)).toBe('ingestion')
    expect(categorise('Login rate limit exceeded', {}, undefined)).toBe('auth')
    expect(
      categorise('ai-settings: ignoring unknown saved key', {}, undefined),
    ).toBe('settings')
  })

  it('falls back to the kind of request, then to system', () => {
    expect(categorise('Something odd', {}, { kind: 'ingest' })).toBe(
      'ingestion',
    )
    expect(categorise('Something odd', {}, { kind: 'chat' })).toBe('retrieval')
    expect(categorise('Something odd', {}, undefined)).toBe('system')
  })
})

describe('request context (FR4)', () => {
  it('reaches log lines written anywhere inside the request, async included', async () => {
    const seen: LogRecord[] = []
    setLogContext(currentContext)
    setLogSink((r) => seen.push(r))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await withRequestContext({ requestId: 'r-1', kind: 'chat' }, async () => {
      annotateContext({ userId: 'u-1' })
      await new Promise((r) => setTimeout(r, 1))
      logger.info('inside')
    })
    logger.info('outside')

    expect(seen[0]?.context).toMatchObject({ requestId: 'r-1', userId: 'u-1' })
    expect(seen[1]?.context).toBeUndefined()
  })

  it('never lets a failing sink break the caller', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    setLogSink(() => {
      throw new Error('sink down')
    })
    expect(() => logger.info('still fine')).not.toThrow()
  })
})

describe('the queue (FR3, NFR1)', () => {
  it('stores a row with its request, category and redacted details', () => {
    const row = toRow(
      record(
        'Planner chose to search',
        { category: 'agent', query: 'leave', apiKey: 'nope' },
        { requestId: 'r-1', userId: 'u-1', conversationId: 'c-1' },
      ),
    )
    expect(row).toMatchObject({
      category: 'agent',
      requestId: 'r-1',
      userId: 'u-1',
      meta: { query: 'leave', apiKey: REDACTED, conversationId: 'c-1' },
    })
    expect(row.meta).not.toHaveProperty('category')
  })

  it('writes in batches', async () => {
    const write = vi.fn(async () => {})
    const queue = createLogQueue(write)
    for (let i = 0; i < BATCH_SIZE + 10; i++) queue.enqueue(record(`line ${i}`))
    await queue.flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(queue.size()).toBe(0)
  })

  it('drops a batch the database refuses, without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const queue = createLogQueue(async () => {
      throw new Error('db down')
    })
    queue.enqueue(record('a'))
    await expect(queue.flush()).resolves.toBeUndefined()
    expect(queue.dropped()).toBe(1)
  })

  it('stays bounded when the database falls behind, keeping the newest', () => {
    const queue = createLogQueue(async () => {})
    for (let i = 0; i < MAX_BUFFER + 25; i++) queue.enqueue(record(`line ${i}`))
    expect(queue.size()).toBe(MAX_BUFFER)
    expect(queue.dropped()).toBe(25)
  })
})
