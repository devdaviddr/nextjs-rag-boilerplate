import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which 404s the inference client retries (#82). An empty-body 404 is a blip
 * worth another attempt. NIM's "Function '…': Not found for account" means a
 * model NIM lists but does not serve to the account: persistent, so it fails
 * at once, naming the model to change. "404 page not found" is a model name
 * that does not exist: fails at once too.
 */

vi.mock('@/lib/env', () => ({
  env: {
    NVIDIA_API_KEY: 'test-key',
    RAG_LLM_BASE_URL: 'https://example.invalid/v1',
    RAG_CHAT_MODEL: 'test-chat',
    RAG_PLANNER_MODEL: 'test-planner',
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import { RagUpstreamError, createChatCompletion } from '@/lib/rag/client'

const COMPLETION = { choices: [{ message: { content: 'ok' } }], usage: {} }

function respond(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response
}

const NIM_BLIP = JSON.stringify({
  status: 404,
  title: 'Not Found',
  detail:
    "Function '9b96341b-9791-4db9-a00d-4e43aa192a39': Not found for account 'abc'",
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('404s', () => {
  it('fails at once on NIM’s "Function … Not found for account", naming the model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(404, NIM_BLIP))
    vi.stubGlobal('fetch', fetchMock)
    const pending = createChatCompletion([{ role: 'user', content: 'q' }], {
      role: 'planner',
    })
    const assertion = expect(pending).rejects.toThrow(
      /"test-planner" is listed by the provider but not available to this account/,
    )
    await vi.runAllTimersAsync()
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still retries an empty-body 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(404, ''))
      .mockResolvedValueOnce(respond(200, JSON.stringify(COMPLETION)))
    vi.stubGlobal('fetch', fetchMock)
    const pending = createChatCompletion([{ role: 'user', content: 'q' }])
    await vi.runAllTimersAsync()
    await pending
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails at once on a wrong model name, so configuration mistakes stay loud', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(respond(404, '404 page not found'))
    vi.stubGlobal('fetch', fetchMock)
    const pending = createChatCompletion([{ role: 'user', content: 'q' }])
    const assertion = expect(pending).rejects.toBeInstanceOf(RagUpstreamError)
    await vi.runAllTimersAsync()
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
