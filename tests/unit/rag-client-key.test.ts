import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The inference key (#136): `LLM_API_KEY`, with `NVIDIA_API_KEY` as a
 * deprecated alias, and no key needed for a custom endpoint such as a local
 * Ollama or llama.cpp server. Only the default NIM endpoint requires one.
 */

const { mockEnv, warn } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
  warn: vi.fn(),
}))
vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/lib/logger', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { DEFAULT_LLM_BASE_URL } from '@/lib/ai-env'
import {
  RagNotConfiguredError,
  createChatCompletion,
  isRagConfigured,
} from '@/lib/rag/client'

const LOCAL = 'http://localhost:11434/v1'

function setEnv(over: Record<string, string | undefined>) {
  for (const k of Object.keys(mockEnv)) delete mockEnv[k]
  Object.assign(mockEnv, { RAG_CHAT_MODEL: 'test-chat' }, over)
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    text: async () => '',
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

/** The Authorization header the last request carried, if any. */
function authorization(): string | undefined {
  const init = fetchMock.mock.calls.at(-1)![1] as RequestInit
  return (init.headers as Record<string, string>).Authorization
}

describe('isRagConfigured', () => {
  it('needs a key for the default NIM endpoint', () => {
    setEnv({ RAG_LLM_BASE_URL: DEFAULT_LLM_BASE_URL })
    expect(isRagConfigured()).toBe(false)
  })

  it('accepts LLM_API_KEY', () => {
    setEnv({ RAG_LLM_BASE_URL: DEFAULT_LLM_BASE_URL, LLM_API_KEY: 'k' })
    expect(isRagConfigured()).toBe(true)
  })

  it('still accepts the deprecated NVIDIA_API_KEY', () => {
    setEnv({ RAG_LLM_BASE_URL: DEFAULT_LLM_BASE_URL, NVIDIA_API_KEY: 'k' })
    expect(isRagConfigured()).toBe(true)
  })

  it('needs no key for a custom endpoint', () => {
    setEnv({ RAG_LLM_BASE_URL: LOCAL })
    expect(isRagConfigured()).toBe(true)
  })
})

describe('the key a request sends', () => {
  it('prefers LLM_API_KEY over the old name', async () => {
    setEnv({
      RAG_LLM_BASE_URL: DEFAULT_LLM_BASE_URL,
      LLM_API_KEY: 'new-key',
      NVIDIA_API_KEY: 'old-key',
    })
    await createChatCompletion([{ role: 'user', content: 'q' }])
    expect(authorization()).toBe('Bearer new-key')
  })

  it('sends the old name, and says once that it is deprecated', async () => {
    setEnv({ RAG_LLM_BASE_URL: DEFAULT_LLM_BASE_URL, NVIDIA_API_KEY: 'old' })
    await createChatCompletion([{ role: 'user', content: 'q' }])
    await createChatCompletion([{ role: 'user', content: 'q' }])
    expect(authorization()).toBe('Bearer old')
    const deprecations = warn.mock.calls.filter(([m]) =>
      String(m).includes('NVIDIA_API_KEY is deprecated'),
    )
    expect(deprecations).toHaveLength(1)
  })

  it('sends no Authorization header to a keyless custom endpoint', async () => {
    setEnv({ RAG_LLM_BASE_URL: LOCAL })
    await createChatCompletion([{ role: 'user', content: 'q' }])
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`${LOCAL}/chat/completions`)
    expect(authorization()).toBeUndefined()
  })

  it('refuses the default endpoint without a key', async () => {
    setEnv({ RAG_LLM_BASE_URL: DEFAULT_LLM_BASE_URL })
    await expect(
      createChatCompletion([{ role: 'user', content: 'q' }]),
    ).rejects.toBeInstanceOf(RagNotConfiguredError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
