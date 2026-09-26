import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The AI settings resolver (spec 0040 FR6): saved → env → default, cached in
 * memory with a TTL, validated exactly as the environment variable is. The
 * table is replaced by a map, so no database is involved.
 */

const { mockEnv, rows, connectionRows, audit, store } = vi.hoisted(() => {
  const rows = new Map<string, string>()
  const connectionRows: unknown[] = []
  const audit: Array<Record<string, unknown>> = []
  return {
    mockEnv: {} as Record<string, unknown>,
    rows,
    connectionRows,
    audit,
    store: {
      writeAudit: vi.fn(
        async (entry: Record<string, unknown>, userId: string | null) => {
          audit.push({ ...entry, userId })
        },
      ),
      readSavedRows: vi.fn(async () =>
        [...rows].map(([key, value]) => ({ key, value })),
      ),
      writeSavedRow: vi.fn(async (key: string, value: string) => {
        rows.set(key, value)
      }),
      deleteSavedRow: vi.fn(async (key: string) => {
        rows.delete(key)
      }),
      readConnectionRows: vi.fn(async () => connectionRows),
    },
  }
})

vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/ai-settings/store', () => store)

import { encryptSecret } from '@/lib/ai-settings/crypto'
import {
  ENV_CONNECTION_ID,
  SAVABLE_KEYS,
  connectionFor,
  modelFor,
  saveRoleConnection,
  TTL_MS,
  __resetAiSettingsForTests,
  aiSettings,
  parseSetting,
  refreshAiSettings,
  resetAiSetting,
  saveAiSetting,
} from '@/lib/ai-settings'

const ENV = {
  AUTH_SECRET: 'auth-secret-for-tests',
  NVIDIA_API_KEY: 'env-key',
  RAG_LLM_BASE_URL: 'https://example.test/v1',
  RAG_CHAT_MODEL: 'env/chat',
  RAG_TOP_K: 8,
  RAG_CHUNK_TOKENS: 512,
  RAG_CHUNK_OVERLAP_TOKENS: 64,
  RAG_MIN_SIMILARITY: 0.35,
  RAG_AGENTIC_ENABLED: true,
}

beforeEach(() => {
  __resetAiSettingsForTests()
  rows.clear()
  connectionRows.length = 0
  audit.length = 0
  for (const k of Object.keys(mockEnv)) delete mockEnv[k]
  Object.assign(mockEnv, ENV)
  vi.clearAllMocks()
  vi.useFakeTimers({ now: 1_000_000 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('aiSettings', () => {
  it('is the environment, read live, before anything is loaded', () => {
    expect(aiSettings().RAG_TOP_K).toBe(8)
    mockEnv.RAG_TOP_K = 12
    expect(aiSettings().RAG_TOP_K).toBe(12)
    expect(store.readSavedRows).not.toHaveBeenCalled()
  })

  it('is still the live environment when nothing is saved', async () => {
    await refreshAiSettings()
    mockEnv.RAG_CHAT_MODEL = 'changed/chat'
    expect(aiSettings().RAG_CHAT_MODEL).toBe('changed/chat')
  })

  it('puts a saved value over the environment, parsed like the variable', async () => {
    rows.set('RAG_TOP_K', '5')
    rows.set('RAG_AGENTIC_ENABLED', 'false')
    rows.set('RAG_CHAT_MODEL', 'saved/chat')
    await refreshAiSettings()
    const s = aiSettings()
    expect(s.RAG_TOP_K).toBe(5)
    expect(s.RAG_AGENTIC_ENABLED).toBe(false)
    expect(s.RAG_CHAT_MODEL).toBe('saved/chat')
    expect(s.RAG_MIN_SIMILARITY).toBe(0.35)
    expect(s.NVIDIA_API_KEY).toBe('env-key')
  })

  it('skips saved rows that are invalid, unknown, or connection secrets', async () => {
    rows.set('RAG_TOP_K', '-3')
    rows.set('RAG_NOT_A_SETTING', 'x')
    rows.set('NVIDIA_API_KEY', 'leaked')
    rows.set('RAG_MIN_SIMILARITY', '0.4')
    await refreshAiSettings()
    const s = aiSettings()
    expect(s.RAG_TOP_K).toBe(8)
    expect(s.NVIDIA_API_KEY).toBe('env-key')
    expect(s.RAG_MIN_SIMILARITY).toBe(0.4)
  })

  it('drops saved chunk sizes that would break the chunker', async () => {
    rows.set('RAG_CHUNK_OVERLAP_TOKENS', '600')
    await refreshAiSettings()
    expect(aiSettings().RAG_CHUNK_OVERLAP_TOKENS).toBe(64)
  })
})

describe('refreshAiSettings', () => {
  it('reads the table at most once per TTL', async () => {
    await refreshAiSettings()
    await refreshAiSettings()
    expect(store.readSavedRows).toHaveBeenCalledTimes(1)

    rows.set('RAG_TOP_K', '3')
    vi.setSystemTime(1_000_000 + TTL_MS + 1)
    await refreshAiSettings()
    expect(store.readSavedRows).toHaveBeenCalledTimes(2)
    expect(aiSettings().RAG_TOP_K).toBe(3)
  })

  it('reloads in the background when a read finds the values stale', async () => {
    await refreshAiSettings()
    rows.set('RAG_TOP_K', '4')
    vi.setSystemTime(1_000_000 + TTL_MS + 1)
    expect(aiSettings().RAG_TOP_K).toBe(8) // this read: the values it has
    await vi.waitFor(() => expect(aiSettings().RAG_TOP_K).toBe(4))
  })

  it('keeps the last good values when the database is down', async () => {
    rows.set('RAG_TOP_K', '6')
    await refreshAiSettings()
    store.readSavedRows.mockRejectedValueOnce(new Error('db down'))
    await expect(refreshAiSettings({ force: true })).resolves.toBeUndefined()
    expect(aiSettings().RAG_TOP_K).toBe(6)
  })
})

describe('saveAiSetting / resetAiSetting', () => {
  it('saves the raw string and applies it to the next read', async () => {
    const result = await saveAiSetting('RAG_TOP_K', '10', 'admin-1')
    expect(result).toEqual({ ok: true })
    expect(store.writeSavedRow).toHaveBeenCalledWith(
      'RAG_TOP_K',
      '10',
      'admin-1',
    )
    expect(aiSettings().RAG_TOP_K).toBe(10)
  })

  it('rejects an out-of-range value with the variable’s own message', async () => {
    const result = await saveAiSetting('RAG_MIN_SIMILARITY', '1.5', null)
    expect(result.ok).toBe(false)
    expect(store.writeSavedRow).not.toHaveBeenCalled()
  })

  it('rejects a value that breaks a rule across settings', async () => {
    expect(
      await saveAiSetting('RAG_CHUNK_OVERLAP_TOKENS', '512', null),
    ).toEqual({
      ok: false,
      error: 'RAG_CHUNK_OVERLAP_TOKENS must be smaller than RAG_CHUNK_TOKENS',
    })
  })

  it('never saves an API key or endpoint as a plain setting', async () => {
    expect(SAVABLE_KEYS).not.toContain('NVIDIA_API_KEY')
    expect(SAVABLE_KEYS).not.toContain('RAG_LLM_BASE_URL')
    const result = await saveAiSetting('NVIDIA_API_KEY', 'sk-123', null)
    expect(result.ok).toBe(false)
    expect(store.writeSavedRow).not.toHaveBeenCalled()
  })

  it('audits a save and a reset, old → new, with who did it (FR5)', async () => {
    await saveAiSetting('RAG_TOP_K', '10', 'admin-1')
    await resetAiSetting('RAG_TOP_K', 'admin-2')
    expect(audit).toEqual([
      {
        action: 'save',
        key: 'RAG_TOP_K',
        oldValue: '8',
        newValue: '10',
        userId: 'admin-1',
      },
      {
        action: 'reset',
        key: 'RAG_TOP_K',
        oldValue: '10',
        newValue: '8',
        userId: 'admin-2',
      },
    ])
  })

  it('does not audit a save that changes nothing, or a reset of an unsaved value', async () => {
    await saveAiSetting('RAG_TOP_K', String(aiSettings().RAG_TOP_K), null)
    await resetAiSetting('RAG_MIN_SIMILARITY', null)
    expect(audit).toEqual([])
  })

  it('reset removes the saved value, so the environment applies again', async () => {
    await saveAiSetting('RAG_CHAT_MODEL', 'saved/chat', null)
    expect(aiSettings().RAG_CHAT_MODEL).toBe('saved/chat')
    await resetAiSetting('RAG_CHAT_MODEL')
    expect(aiSettings().RAG_CHAT_MODEL).toBe('env/chat')
  })
})

describe('parseSetting', () => {
  it('applies the same defaults and bounds as the environment', () => {
    expect(parseSetting('RAG_TOP_K', '0').ok).toBe(false)
    expect(parseSetting('RAG_TOP_K', '12')).toEqual({ ok: true, value: 12 })
    expect(parseSetting('RAG_RERANK_BACKEND', 'llm')).toEqual({
      ok: true,
      value: 'llm',
    })
    expect(parseSetting('RAG_RERANK_BACKEND', 'other').ok).toBe(false)
  })
})

describe('connections (spec 0040 FR1, FR2)', () => {
  const openrouter = () => ({
    id: 'c-1',
    name: 'OpenRouter',
    preset: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyCiphertext: encryptSecret('sk-or-secret-1234'),
  })

  it('sends every job to the .env endpoint until one is chosen', async () => {
    connectionRows.push(openrouter())
    await refreshAiSettings()
    const chat = connectionFor('chat')
    expect(chat.id).toBe(ENV_CONNECTION_ID)
    expect(chat.baseUrl).toBe('https://example.test/v1')
    expect(chat.apiKey).toBe('env-key')
  })

  it('points a job at a saved connection, with its key decrypted', async () => {
    connectionRows.push(openrouter())
    rows.set('connection:chat', 'c-1')
    await refreshAiSettings()
    expect(connectionFor('chat')).toMatchObject({
      id: 'c-1',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-secret-1234',
      keyUnreadable: false,
    })
    expect(connectionFor('planner').id).toBe(ENV_CONNECTION_ID)
  })

  it('falls back to .env when the chosen connection was deleted', async () => {
    rows.set('connection:chat', 'gone')
    await refreshAiSettings()
    expect(connectionFor('chat').id).toBe(ENV_CONNECTION_ID)
  })

  it('never moves embeddings, even if a row says so', async () => {
    connectionRows.push(openrouter())
    rows.set('connection:embed', 'c-1')
    await refreshAiSettings()
    expect(connectionFor('embed').id).toBe(ENV_CONNECTION_ID)
    expect(await saveRoleConnection('embed', 'c-1', null)).toMatchObject({
      ok: false,
    })
  })

  it('flags a key that no longer decrypts instead of sending garbage', async () => {
    connectionRows.push({ ...openrouter(), apiKeyCiphertext: 'v1:AAAA' })
    rows.set('connection:chat', 'c-1')
    await refreshAiSettings()
    expect(connectionFor('chat')).toMatchObject({
      apiKey: undefined,
      keyUnreadable: true,
    })
  })

  it('saves a job’s connection, and refuses one that does not exist', async () => {
    connectionRows.push(openrouter())
    expect(await saveRoleConnection('planner', 'c-1', 'admin')).toEqual({
      ok: true,
    })
    expect(connectionFor('planner').id).toBe('c-1')
    expect(await saveRoleConnection('planner', 'nope', 'admin')).toMatchObject({
      ok: false,
    })
    expect(
      await saveRoleConnection('planner', ENV_CONNECTION_ID, null),
    ).toEqual({ ok: true })
    expect(connectionFor('planner').id).toBe(ENV_CONNECTION_ID)
  })

  it('gives each job its own model setting', async () => {
    rows.set('RAG_CHAT_MODEL', 'or/some-chat')
    await refreshAiSettings()
    expect(modelFor('chat')).toBe('or/some-chat')
  })
})
