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
    APP_URL: 'http://localhost:3000',
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
    RAG_TOP_K: 8,
    RAG_MIN_SIMILARITY: 0.35,
  } as Record<string, unknown>,
  store: {
    rows: new Map<string, string>(),
    connections: [] as Array<Record<string, unknown>>,
    audit: [] as Array<Record<string, unknown>>,
  },
}))

vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/lib/rag/generations', () => ({
  reindexView: async () => ({
    activeModel: 'env/embed',
    activeDimensions: 2048,
    building: null,
  }),
  startGeneration: vi.fn(),
  buildGeneration: vi.fn(),
  cancelGeneration: vi.fn(),
}))
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
  readActiveGeneration: vi.fn(async () => null),
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
  deleteConnection: vi.fn(async (id: string) => {
    const i = store.connections.findIndex((c) => c.id === id)
    if (i >= 0) store.connections.splice(i, 1)
  }),
  writeAudit: vi.fn(
    async (entry: Record<string, unknown>, userId: string | null) => {
      store.audit.push({ ...entry, userId })
    },
  ),
  readRecentAudit: vi.fn(async () =>
    [...store.audit]
      .reverse()
      .map((e) => ({ ...e, at: new Date(0), by: 'Admin' })),
  ),
}))

import { __resetAiSettingsForTests } from '@/lib/ai-settings'
import {
  deleteConnection,
  getAiSettingsView,
  resetRetrievalSetting,
  resetRole,
  saveConnection,
  saveRetrievalSetting,
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
  store.audit.length = 0
  mockEnv.AI_SETTINGS_LOCKED = false
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

  it('changes the embedding model only by starting a re-index (FR3)', async () => {
    const generations = await import('@/lib/rag/generations')
    const { after } = await import('next/server')
    vi.mocked(generations.startGeneration).mockResolvedValueOnce({
      ok: true,
      generationId: 'gen-2',
      dimensions: 3072,
      totalChunks: 40,
    })
    expect(
      await saveRole({ role: 'embed', connectionId: 'env', model: 'other' }),
    ).toEqual({ ok: true, data: null })
    // Not saved as a setting: the new model applies when its index is ready.
    expect(store.rows.size).toBe(0)
    expect(generations.startGeneration).toHaveBeenCalledWith('other', 'admin-1')
    expect(after).toHaveBeenCalled()
    expect(store.audit).toContainEqual(
      expect.objectContaining({
        key: 'RAG_EMBED_MODEL',
        newValue: 'other (re-indexing 40 passages, 3072 dimensions)',
      }),
    )
  })

  it('passes on why a re-index could not start', async () => {
    const generations = await import('@/lib/rag/generations')
    vi.mocked(generations.startGeneration).mockResolvedValueOnce({
      ok: false,
      error:
        'huge returns 4096-dimensional vectors; the index takes 1 to 4000.',
    })
    expect(
      await saveRole({ role: 'embed', connectionId: 'env', model: 'huge' }),
    ).toEqual({
      ok: false,
      error:
        'huge returns 4096-dimensional vectors; the index takes 1 to 4000.',
    })
    expect(store.audit).toHaveLength(0)
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

describe('FR5: provenance, audit and lock', () => {
  it('audits a connection without its key, only the hint', async () => {
    await saveConnection({
      name: 'OpenRouter',
      preset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: SECRET,
    })
    await deleteConnection('c-1')
    const text = JSON.stringify(store.audit)
    expect(text).not.toContain(SECRET)
    expect(store.audit).toEqual([
      {
        action: 'connection-add',
        key: 'OpenRouter',
        oldValue: null,
        newValue: 'OpenRouter · https://openrouter.ai/api/v1 · key ••••9876',
        userId: 'admin-1',
      },
      {
        action: 'connection-remove',
        key: 'OpenRouter',
        oldValue: 'OpenRouter · https://openrouter.ai/api/v1 · key ••••9876',
        newValue: null,
        userId: 'admin-1',
      },
    ])
  })

  it('audits a job moved to a connection and a new model, and shows who saved it', async () => {
    await saveConnection({
      name: 'OpenRouter',
      preset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: SECRET,
    })
    store.audit.length = 0
    await saveRole({ role: 'chat', connectionId: 'c-1', model: 'or/chat' })
    expect(store.audit.map((e) => [e.key, e.oldValue, e.newValue])).toEqual([
      ['connection:chat', 'Environment (.env)', 'OpenRouter'],
      ['RAG_CHAT_MODEL', 'env/chat', 'or/chat'],
    ])
    const view = await getAiSettingsView()
    expect(view.ok && view.data.recentChanges[0]).toMatchObject({
      key: 'RAG_CHAT_MODEL',
      by: 'Admin',
    })
  })

  it('refuses every change when AI_SETTINGS_LOCKED is set, but still shows and tests', async () => {
    mockEnv.AI_SETTINGS_LOCKED = true
    const LOCKED =
      'AI settings are locked on this deployment (AI_SETTINGS_LOCKED). Change them in .env.'
    const writes = await Promise.all([
      saveConnection({
        name: 'x',
        preset: 'custom',
        baseUrl: 'https://example.test/v1',
      }),
      deleteConnection('c-1'),
      saveRole({ role: 'chat', connectionId: 'env', model: 'm' }),
      resetRole('chat'),
    ])
    for (const r of writes) expect(r).toEqual({ ok: false, error: LOCKED })
    expect(store.connections).toHaveLength(0)
    expect(store.rows.size).toBe(0)
    expect(store.audit).toHaveLength(0)

    const view = await getAiSettingsView()
    expect(view.ok && view.data.locked).toBe(true)
  })
})

describe('FR4: retrieval and answering', () => {
  it('saves a setting, applies it, shows it as saved, and audits it', async () => {
    expect(await saveRetrievalSetting('RAG_TOP_K', ' 5 ')).toEqual({
      ok: true,
      data: null,
    })
    expect(store.rows.get('RAG_TOP_K')).toBe('5')
    const view = await getAiSettingsView()
    const field =
      view.ok && view.data.retrieval.find((f) => f.key === 'RAG_TOP_K')
    expect(field).toMatchObject({ value: '5', source: 'saved' })
    expect(store.audit).toContainEqual(
      expect.objectContaining({
        key: 'RAG_TOP_K',
        oldValue: '8',
        newValue: '5',
      }),
    )
  })

  it('rejects an out-of-range value with the allowed range', async () => {
    expect(await saveRetrievalSetting('RAG_MIN_SIMILARITY', '1.5')).toEqual({
      ok: false,
      error: 'Relevance floor must be a number from 0 to 1.',
    })
    expect(await saveRetrievalSetting('RAG_TOP_K', '0')).toEqual({
      ok: false,
      error: 'Passages per answer must be a whole number from 1 up.',
    })
    expect(store.rows.size).toBe(0)
  })

  it('offers only the listed settings, never a model or a key', async () => {
    for (const key of [
      'RAG_CHAT_MODEL',
      'NVIDIA_API_KEY',
      'RAG_LLM_BASE_URL',
    ]) {
      const result = await saveRetrievalSetting(key, 'x')
      expect(result.ok).toBe(false)
    }
    expect(store.rows.size).toBe(0)
  })

  it('resets a saved setting to .env', async () => {
    await saveRetrievalSetting('RAG_TOP_K', '5')
    expect(await resetRetrievalSetting('RAG_TOP_K')).toEqual({
      ok: true,
      data: null,
    })
    expect(store.rows.has('RAG_TOP_K')).toBe(false)
  })

  it('is admin only and refused when locked', async () => {
    isAdmin.value = false
    expect((await saveRetrievalSetting('RAG_TOP_K', '5')).ok).toBe(false)
    isAdmin.value = true
    mockEnv.AI_SETTINGS_LOCKED = true
    expect((await saveRetrievalSetting('RAG_TOP_K', '5')).ok).toBe(false)
    expect((await resetRetrievalSetting('RAG_TOP_K')).ok).toBe(false)
    expect(store.rows.size).toBe(0)
  })
})

describe('FR9: provider behaviour', () => {
  it('sends OpenRouter its attribution headers and reads context and price', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-4o-mini',
              context_length: 128000,
              pricing: { prompt: '0.00000015' },
            },
            {
              id: 'meta/free-model',
              context_length: 8192,
              pricing: { prompt: '0' },
            },
          ],
        }),
      ),
    )
    const result = await testConnection({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: SECRET,
      preset: 'openrouter',
    })
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >
    expect(headers['X-Title']).toBeTruthy()
    expect(headers['HTTP-Referer']).toMatch(/^https?:\/\//)
    expect(result).toMatchObject({
      ok: true,
      data: {
        models: ['meta/free-model', 'openai/gpt-4o-mini'],
        details: {
          'openai/gpt-4o-mini': {
            contextLength: 128000,
            promptPerMillion: 0.15,
          },
          'meta/free-model': { contextLength: 8192, promptPerMillion: 0 },
        },
      },
    })
  })

  it('sends no attribution headers to other providers', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] })))
    await testConnection({ id: 'env' })
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >
    expect(headers).not.toHaveProperty('X-Title')
  })

  it('tests chat by streaming, and says so when the endpoint does not stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
      ),
    )
    expect(await testRole('chat')).toMatchObject({
      ok: true,
      data: { detail: 'streamed an answer' },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
      ),
    )
    const result = await testRole('chat')
    expect(!result.ok && result.error).toContain('did not stream')
  })

  it('tells an embeddings endpoint that is missing how a llama.cpp server enables it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 }),
    )
    const result = await testRole('embed')
    expect(!result.ok && result.error).toContain('--embeddings')
  })
})
