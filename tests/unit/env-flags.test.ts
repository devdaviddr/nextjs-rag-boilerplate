import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Default-on flags must stay on unless explicitly 'false'. `.default()` only
 * covers an unset variable; an empty value (as generated env files write) or
 * '1' reaching a `v === 'true'` check would silently turn the feature off.
 */

async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules()
  vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5432/db')
  vi.stubEnv('AUTH_SECRET', 'test-secret')
  vi.stubEnv('S3_ENDPOINT', 'http://localhost:9000')
  vi.stubEnv('S3_ACCESS_KEY_ID', 'key')
  vi.stubEnv('S3_SECRET_ACCESS_KEY', 'secret')
  vi.stubEnv('S3_BUCKET', 'bucket')
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value)
  return (await import('@/lib/env')).env
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('RAG_PARENT_ASSEMBLY (spec 0033, 1c)', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ["'true'", 'true'],
    ["'1'", '1'],
    ["'TRUE'", 'TRUE'],
  ])('is on when %s', async (_label, value) => {
    const env = await loadEnv({ RAG_PARENT_ASSEMBLY: value })
    expect(env.RAG_PARENT_ASSEMBLY).toBe(true)
  })

  it("is off only for 'false'", async () => {
    const env = await loadEnv({ RAG_PARENT_ASSEMBLY: 'false' })
    expect(env.RAG_PARENT_ASSEMBLY).toBe(false)
  })
})
