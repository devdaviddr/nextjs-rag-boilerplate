import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The prefix-scoped listing and delete that `eval/run.ts`'s `clearCorpus` uses
 * to stop leaking the corpus PDFs it uploads (one per document, every
 * `pnpm rag:eval`).
 *
 * `pnpm rag:eval` clears a shared database and spends a shared rate-limited
 * key, so it is not a thing a test may run. The S3 client is mocked instead,
 * which is the right seam anyway: what needs proving is not that MinIO deletes
 * objects, it is that this code can only ever ask it to delete the eval user's.
 */

// Hoisted, because `vi.mock`'s factory runs before any module-level `const`.
const { send } = vi.hoisted(() => ({ send: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/env', () => ({
  env: {
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
  },
}))
vi.mock('@aws-sdk/client-s3', () => {
  // Each command records its own name and input so an assertion can tell a
  // list from a delete without reaching into the real SDK's internals.
  class FakeCommand {
    constructor(
      readonly name: string,
      readonly input: Record<string, unknown>,
    ) {}
  }
  return {
    S3Client: class {
      send = send
    },
    ListObjectsV2Command: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('ListObjectsV2', input)
      }
    },
    DeleteObjectCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DeleteObject', input)
      }
    },
    GetObjectCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('GetObject', input)
      }
    },
    PutObjectCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('PutObject', input)
      }
    },
  }
})

import { deleteObjectsUnderPrefix, listObjectKeys } from '@/lib/storage/client'

interface SentCommand {
  name: string
  input: Record<string, unknown>
}

const sent = () => send.mock.calls.map(([c]) => c as SentCommand)
const deletedKeys = () =>
  sent()
    .filter((c) => c.name === 'DeleteObject')
    .map((c) => c.input.Key as string)

/** One page of a listing, in the shape the SDK returns. */
const page = (keys: string[], next?: string) => ({
  Contents: keys.map((Key) => ({ Key })),
  IsTruncated: next !== undefined,
  NextContinuationToken: next,
})

const EVAL_PREFIX = 'eval-harness-user/'

beforeEach(() => {
  send.mockReset()
})

describe('listObjectKeys', () => {
  it('lists under the prefix it was given', async () => {
    send.mockResolvedValueOnce(
      page([`${EVAL_PREFIX}staff-handbook-1.pdf`, `${EVAL_PREFIX}a.pdf`]),
    )

    const keys = await listObjectKeys(EVAL_PREFIX)

    expect(keys).toEqual([
      `${EVAL_PREFIX}staff-handbook-1.pdf`,
      `${EVAL_PREFIX}a.pdf`,
    ])
    expect(sent()[0]?.input).toMatchObject({
      Bucket: 'test-bucket',
      Prefix: EVAL_PREFIX,
    })
  })

  it('follows pagination rather than stopping at the first page', async () => {
    send
      .mockResolvedValueOnce(page([`${EVAL_PREFIX}one.pdf`], 'token-1'))
      .mockResolvedValueOnce(page([`${EVAL_PREFIX}two.pdf`]))

    const keys = await listObjectKeys(EVAL_PREFIX)

    expect(keys).toHaveLength(2)
    expect(sent()[1]?.input).toMatchObject({ ContinuationToken: 'token-1' })
  })

  it('refuses a prefix that is not folder-bounded', async () => {
    // "eval-harness-user" without the slash is a substring match on S3, so it
    // would also match a hypothetical "eval-harness-user-2/..." — a different
    // owner. The empty prefix is the whole bucket.
    for (const unbounded of ['', 'eval-harness-user', '/', 'a/b']) {
      await expect(listObjectKeys(unbounded)).rejects.toThrow(/prefix/i)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('drops a key the endpoint returns that is outside the prefix', async () => {
    // S3 promises it never does this. An endpoint that does must not be able
    // to widen a delete, which is what this listing feeds.
    send.mockResolvedValueOnce(
      page([`${EVAL_PREFIX}mine.pdf`, 'someone-else/private.pdf']),
    )

    expect(await listObjectKeys(EVAL_PREFIX)).toEqual([
      `${EVAL_PREFIX}mine.pdf`,
    ])
  })

  it('treats an empty bucket as empty, not as an error', async () => {
    send.mockResolvedValueOnce({ IsTruncated: false })
    expect(await listObjectKeys(EVAL_PREFIX)).toEqual([])
  })
})

describe('deleteObjectsUnderPrefix', () => {
  it('deletes every listed key and reports the count', async () => {
    send
      .mockResolvedValueOnce(
        page([`${EVAL_PREFIX}one.pdf`, `${EVAL_PREFIX}two.pdf`]),
      )
      .mockResolvedValue({})

    expect(await deleteObjectsUnderPrefix(EVAL_PREFIX)).toBe(2)
    expect(deletedKeys()).toEqual([
      `${EVAL_PREFIX}one.pdf`,
      `${EVAL_PREFIX}two.pdf`,
    ])
  })

  it('deletes nothing outside the prefix, even if the listing returns it', async () => {
    send
      .mockResolvedValueOnce(
        page([
          `${EVAL_PREFIX}mine.pdf`,
          'real-user-id/annual-leave-policy.pdf',
        ]),
      )
      .mockResolvedValue({})

    expect(await deleteObjectsUnderPrefix(EVAL_PREFIX)).toBe(1)
    expect(deletedKeys()).toEqual([`${EVAL_PREFIX}mine.pdf`])
  })

  it('issues no delete at all for an unbounded prefix', async () => {
    await expect(deleteObjectsUnderPrefix('')).rejects.toThrow(/prefix/i)
    expect(deletedKeys()).toEqual([])
  })

  it('is a no-op on an already-clean bucket, so it is safe to re-run', async () => {
    send.mockResolvedValueOnce(page([]))
    expect(await deleteObjectsUnderPrefix(EVAL_PREFIX)).toBe(0)
    expect(deletedKeys()).toEqual([])
  })
})
