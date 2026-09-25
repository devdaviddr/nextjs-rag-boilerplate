import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Settings → AI provider / Models server actions (spec 0040 FR1, FR2, FR7,
 * NFR3): admin-only in the action itself, and an API key goes in but never
 * comes back out.
 */

const { isAdmin, store, mockEnv } = vi.hoisted(() => ({
  isAdmin: { value: true },
  mockEnv: {
    AUTH_SECRET: 'auth-secret-for-tests',
    NVIDIA_API_KEY: 'nvapi-env-key-000011112222',
    RAG_LLM_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    RAG_CHAT_MODEL: 'env/chat',
    RAG_PLANNER_MODEL: 'env/planner',
    RAG_HYDE_MODEL: 'env/hyde',
    RAG_VISION_MODEL: 'env/vision',
    RAG_PARSE_MODEL: 'env/parse',
    RAG_EMBED_MODEL: 'env/embed',
    RAG_CHUNK_TOKENS: 512,
    RAG_CHUNK_OVERLAP_TOKENS: 64,
  } as Record<string, unknown>,
  store: {
    rows: new Map<string, string>(),
    connections: [] as Array<Record<string, unknown>>,
  },
}))

vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/rag/agentic-run', () => ({ PLANNER_SYSTEM_PROMPT: 'plan' }))
vi.mock('@/lib/rag/planner', () => ({ SEARCH_TOOL: {} }))
vi.mock('@/lib/auth/session', () => ({
  getCurrentSession: async () => ({
    user: { id: 'admin-1', roles: ['admin'] },
  }),
}))
vi.mock('@/lib/auth/rbac', () => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    requireRole: vi.fn(async () => {
      if (!isAdmin.value) throw new ForbiddenError()
    }),
  }
})
vi.mock('@/lib/ai-settings/store', () => ({
  readSavedRows: vi.fn(async () =>
    [...store.rows].map(([key, value]) => ({ key, value })),
  ),
  writeSavedRow: vi.fn(async (key: string, value: string) => {
    store.rows.set(key, value)
  }),
  deleteSavedRow: vi.fn(async (key: string) => {
    store.rows.delete(key)
  }),
  readConnectionRows: vi.fn(async () => store.connections),
  insertConnection: vi.fn(async (values: Record<string, unknown>) => {
    const key = values.apiKey as { ciphertext: string; hint: string } | null
    store.connections.push({
      id: `c-${store.connections.length + 1}`,
      name: values.name,
      preset: values.preset,
      baseUrl: values.baseUrl,
      apiKeyCiphertext: key?.ciphertext ?? null,
      apiKeyHint: key?.hint ?? null,
    })
    return `c-${store.connections.length}`
  }),
  updateConnection: vi.fn(async () => true),
  deleteConnection: vi.fn(async () => {}),
}))

import { __resetAiSettingsForTests } from '@/lib/ai-settings'
import {
  deleteConnection,
  getAiSettingsView,
  resetRole,
  saveConnection,
  saveRole,
  testConnection,
  testRole,
} from '@/lib/ai-settings/actions'

const SECRET = 'sk-or-v1-very-secret-key-9876'

beforeEach(() => {
  __resetAiSettingsForTests()
  isAdmin.value = true
  store.rows.clear()
  store.connections.length = 0
  vi.restoreAllMocks()
})

describe('FR7: admin only, enforced by the actions', () => {
  it('refuses every action to a non-admin, before touching anything', async () => {
    isAdmin.value = false
    const results = await Promise.all([
      getAiSettingsView(),
      saveConnection({
        name: 'x',
        preset: 'custom',
        baseUrl: 'https://example.test/v1',
      }),
      deleteConnection('c-1'),
      testConnection({ id: 'env' }),
      saveRole({ role: 'chat', connectionId: 'env', model: 'm' }),
      resetRole('chat'),
      testRole('chat'),
    ])
    for (const r of results) {
      expect(r).toEqual({
        ok: false,
        error: 'Only admins can change AI settings.',
      })
    }
    expect(store.connections).toHaveLength(0)
    expect(store.rows.size).toBe(0)
  })
})

describe('FR1 / NFR3: keys go in and never come out', () => {
  it('saves a connection with an encrypted key and shows only a hint', async () => {
    const saved = await saveConnection({
      name: 'OpenRouter',
      preset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: SECRET,
    })
    expect(saved.ok).toBe(true)
    expect(JSON.stringify(store.connections)).not.toContain(SECRET)

    const view = await getAiSettingsView()
    const text = JSON.stringify(view)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(mockEnv.NVIDIA_API_KEY as string)
    expect(view.ok && view.data.connections.map((c) => c.keyHint)).toEqual([
      '••••2222',
      '••••9876',
    ])
    expect(view.ok && view.data.connections[1]?.baseUrl).toBe(
      'https://openrouter.ai/api/v1',
    )
  })

  it('requires a key for a provider that needs one, and a real URL', async () => {
    expect(
      await saveConnection({
        name: 'NIM',
        preset: 'nvidia-nim',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
      }),
    ).toMatchObject({ ok: false, error: 'NVIDIA NIM needs an API key' })
    expect(
      await saveConnection({
        name: 'Local',
        preset: 'llama-cpp',
        baseUrl: 'http://<host>:8080/v1',
      }),
    ).toMatchObject({ ok: false })
  })

  it('tests a connection without returning the response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }], secret: 'x' }),
      ),
    )
    const result = await testConnection({ id: 'env' })
    expect(result).toMatchObject({ ok: true, data: { models: ['a', 'b'] } })
    expect(JSON.stringify(result)).not.toContain('secret')
    const [, init] = vi.mocked(fetch).mock.calls[0]!
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${mockEnv.NVIDIA_API_KEY}`,
    )
  })
})

describe('FR2: jobs', () => {
  it('points a job at a connection and a model', async () => {
    await saveConnection({
      name: 'Local',
      preset: 'llama-cpp',
      baseUrl: 'http://10.0.0.5:8080/v1',
    })
    const result = await saveRole({
      role: 'chat',
      connectionId: 'c-1',
      model: 'qwen3-8b',
    })
    expect(result.ok).toBe(true)
    expect(store.rows.get('connection:chat')).toBe('c-1')
    expect(store.rows.get('RAG_CHAT_MODEL')).toBe('qwen3-8b')

    await resetRole('chat')
    expect(store.rows.has('connection:chat')).toBe(false)
    expect(store.rows.has('RAG_CHAT_MODEL')).toBe(false)
  })

  it('will not change the embedding model without a re-index', async () => {
    expect(
      await saveRole({ role: 'embed', connectionId: 'env', model: 'other' }),
    ).toMatchObject({ ok: false })
    expect(store.rows.size).toBe(0)
  })

  it('tells a llama.cpp planner without tool calls how to fix it', async () => {
    await saveConnection({
      name: 'Local',
      preset: 'llama-cpp',
      baseUrl: 'http://10.0.0.5:8080/v1',
    })
    await saveRole({ role: 'planner', connectionId: 'c-1', model: 'm' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
      ),
    )
    const result = await testRole('planner')
    expect(result).toMatchObject({ ok: false })
    expect(!result.ok && result.error).toContain('--jinja')
  })

  it('checks the embedding size the index needs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] })),
    )
    const result = await testRole('embed')
    expect(!result.ok && result.error).toContain('needs 2048')
  })
})
