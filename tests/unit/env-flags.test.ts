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

describe('PWA_ENABLED and OBSERVABILITY_UI_ENABLED (#140)', () => {
  it.each(['PWA_ENABLED', 'OBSERVABILITY_UI_ENABLED'] as const)(
    '%s is on unless it is exactly false',
    async (key) => {
      expect((await loadEnv({ [key]: undefined }))[key]).toBe(true)
      expect((await loadEnv({ [key]: '' }))[key]).toBe(true)
      expect((await loadEnv({ [key]: 'false' }))[key]).toBe(false)
    },
  )
})

describe('object storage (#137)', () => {
  const noS3 = {
    S3_ENDPOINT: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_BUCKET: undefined,
  }

  it('boots without S3, keeping files on disk', async () => {
    const env = await loadEnv(noS3)
    expect(env.S3_ENDPOINT).toBeUndefined()
    expect(env.STORAGE_DIR).toBe('./data/storage')
  })

  it('treats empty S3 values as unset', async () => {
    const env = await loadEnv({
      S3_ENDPOINT: '',
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
      S3_BUCKET: '',
    })
    expect(env.S3_ENDPOINT).toBeUndefined()
  })

  it('refuses an S3 endpoint without its credentials and bucket', async () => {
    await expect(
      loadEnv({ ...noS3, S3_ENDPOINT: 'http://localhost:9000' }),
    ).rejects.toThrow(/S3_BUCKET is required when S3_ENDPOINT is set/)
  })
})
