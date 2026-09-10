import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The per-attempt deadline on inference requests.
 *
 * `fetch` has no timeout of its own, so a stalled upstream used to hang a
 * request indefinitely — measured 2026-09-10 at 86s on a planner call that
 * normally takes 3-6, against an agentic loop budget of 15s that could do
 * nothing about it, because that budget is only checked between iterations.
 *
 * These tests drive the real `post()` through its public callers with a fake
 * `fetch`, so what is pinned is the observable behaviour: a stall is retried, a
 * caller abort is not, and neither hangs.
 */

vi.mock('@/lib/env', () => ({
  env: {
    NVIDIA_API_KEY: 'test-key',
    RAG_LLM_BASE_URL: 'https://example.invalid/v1',
    RAG_CHAT_MODEL: 'test-chat',
    RAG_EMBED_MODEL: 'test-embed',
    RAG_PLANNER_MODEL: 'test-planner',
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import { RagUpstreamError, createChatCompletion } from '@/lib/rag/client'

/** A fetch that never settles until the signal it was given aborts. */
function stallingFetch() {
  return vi.fn((_url: string, init: { signal?: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(init.signal?.reason ?? new Error('aborted')),
      )
    })
  })
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const COMPLETION = { choices: [{ message: { content: 'hi' } }], usage: {} }

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('inference request deadlines', () => {
  it('gives up on a stalled attempt instead of hanging forever', async () => {
    const fetchMock = stallingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const promise = createChatCompletion([{ role: 'user', content: 'hello' }], {
      timeoutMs: 1_000,
    }).catch((error: unknown) => error)

    // Four attempts, each hitting its deadline, with backoff between them.
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await promise

    expect(result).toBeInstanceOf(RagUpstreamError)
    expect((result as Error).message).toContain('1000ms')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('recovers when a later attempt answers', async () => {
    let attempt = 0
    const fetchMock = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      attempt++
      if (attempt === 1) {
        return new Promise<Response>((_r, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('to')))
        })
      }
      return Promise.resolve(jsonResponse(COMPLETION))
    })
    vi.stubGlobal('fetch', fetchMock)

    const promise = createChatCompletion([{ role: 'user', content: 'hi' }], {
      timeoutMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(10_000)

    const { choice } = await promise
    expect(choice.message?.content).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry when the caller aborted', async () => {
    // A browser that navigated away is not a transient fault. Retrying it
    // would keep generating an answer nobody is waiting for.
    const fetchMock = stallingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    const promise = createChatCompletion([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
      timeoutMs: 60_000,
    }).catch((error: unknown) => error)

    controller.abort(new Error('client went away'))
    await vi.advanceTimersByTimeAsync(10)

    const result = await promise
    expect(result).toBeInstanceOf(Error)
    expect(result).not.toBeInstanceOf(RagUpstreamError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('passes the caller signal through so an abort still reaches fetch', async () => {
    const fetchMock = stallingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    void createChatCompletion([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    }).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(1)

    const passed = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal }
    expect(passed.signal).toBeInstanceOf(AbortSignal)
    expect(passed.signal?.aborted).toBe(false)
    controller.abort()
    expect(passed.signal?.aborted).toBe(true)
  })
})
