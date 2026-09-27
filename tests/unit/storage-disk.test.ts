import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The local-disk storage backend (#137), used when S3_ENDPOINT is unset. Real
 * files in a temporary folder: what needs proving is the behaviour the app
 * relies on from S3, and that no key can reach outside the storage folder.
 */

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/env', () => ({ env: mockEnv }))

import {
  deleteObject,
  deleteObjectsUnderPrefix,
  getObjectBuffer,
  getObjectStream,
  listObjectKeys,
  putObject,
  storageBackend,
} from '@/lib/storage/client'

let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'storage-disk-'))
  mockEnv.STORAGE_DIR = root
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe('the disk backend', () => {
  it('is chosen when no S3 endpoint is set', () => {
    expect(storageBackend()).toBe('disk')
  })

  it('stores, reads back and deletes an object', async () => {
    await putObject('user-1/a.pdf', Buffer.from('%PDF-1.7 hello'), 'x')
    expect((await getObjectBuffer('user-1/a.pdf')).toString()).toBe(
      '%PDF-1.7 hello',
    )

    const { body, contentLength } = await getObjectStream('user-1/a.pdf')
    expect(contentLength).toBe(14)
    expect(await new Response(body).text()).toBe('%PDF-1.7 hello')

    await deleteObject('user-1/a.pdf')
    await expect(getObjectBuffer('user-1/a.pdf')).rejects.toThrow()
    // Deleting what is already gone is not an error, as on S3.
    await expect(deleteObject('user-1/a.pdf')).resolves.toBeUndefined()
  })

  it('lists and deletes only under a folder prefix', async () => {
    await putObject('eval/x/1.pdf', Buffer.from('1'), 'x')
    await putObject('eval/x/deep/2.pdf', Buffer.from('2'), 'x')
    await putObject('eval/xy/3.pdf', Buffer.from('3'), 'x')

    expect((await listObjectKeys('eval/x/')).sort()).toEqual([
      'eval/x/1.pdf',
      'eval/x/deep/2.pdf',
    ])
    expect(await listObjectKeys('nothing-here/')).toEqual([])
    await expect(listObjectKeys('eval/x')).rejects.toThrow(/unbounded/)

    expect(await deleteObjectsUnderPrefix('eval/x/')).toBe(2)
    expect(await listObjectKeys('eval/xy/')).toEqual(['eval/xy/3.pdf'])
  })

  it('refuses a key that would leave the storage folder', async () => {
    await expect(
      putObject('../escape.txt', Buffer.from('no'), 'x'),
    ).rejects.toThrow(/outside the storage folder/)
    await expect(getObjectBuffer('/etc/passwd')).rejects.toThrow(
      /outside the storage folder/,
    )
    await expect(listObjectKeys('../')).rejects.toThrow(
      /outside the storage folder/,
    )
    expect(await readdir(path.dirname(root))).not.toContain('escape.txt')
  })
})
