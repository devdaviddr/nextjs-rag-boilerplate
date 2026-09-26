import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The local cross-encoder backend (spec 0036 FR2). The model loader is
 * injected, so these tests never load the ONNX runtime or touch the network.
 * That the real model loads and ranks sensibly — on Debian slim as well as macOS —
 * is checked by the eval run recorded in the spec, not here.
 */

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    RAG_RERANK_LOCAL_MODEL: 'test/cross-encoder',
    RAG_RERANK_MODEL_DIR: '/models',
    RAG_RERANK_THREADS: 2,
  } as Record<string, unknown>,
}))

vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  type ModelLoader,
  cachedModelFile,
  createLocalReranker,
  modelCacheDir,
  padBatch,
} from '@/lib/rag/rerank-local'

/** A loader whose model scores each passage by its length. */
function lengthLoader() {
  const score = vi.fn(async (_q: string, passages: readonly string[]) =>
    passages.map((p) => p.length),
  )
  const loader = vi.fn(async () => ({ score }))
  return { loader: loader as unknown as ModelLoader & typeof loader, score }
}

describe('createLocalReranker', () => {
  it('returns one score per passage, aligned by index', async () => {
    const { loader, score } = lengthLoader()
    const reranker = createLocalReranker(loader)
    expect(await reranker.score('q', ['a', 'ccc', 'bb'])).toEqual([1, 3, 2])
    expect(score).toHaveBeenCalledWith('q', ['a', 'ccc', 'bb'])
    expect(reranker.name).toBe('local')
  })

  it('loads the configured model once, into the configured directory', async () => {
    const { loader } = lengthLoader()
    const reranker = createLocalReranker(loader)
    await reranker.score('q', ['a'])
    await reranker.score('q', ['b'])
    expect(loader).toHaveBeenCalledTimes(1)
    expect(loader).toHaveBeenCalledWith('test/cross-encoder', '/models', 2)
  })

  it('loads a new session when the model or thread count changes', async () => {
    const { loader } = lengthLoader()
    const reranker = createLocalReranker(loader)
    await reranker.score('q', ['a'])
    mockEnv.RAG_RERANK_THREADS = 1
    await reranker.score('q', ['a'])
    await reranker.score('q', ['a'])
    expect(loader).toHaveBeenCalledTimes(2)
    expect(loader).toHaveBeenLastCalledWith('test/cross-encoder', '/models', 1)
    mockEnv.RAG_RERANK_THREADS = 2
  })

  it('spends nothing on an empty list or an aborted request', async () => {
    const { loader } = lengthLoader()
    const reranker = createLocalReranker(loader)
    expect(await reranker.score('q', [])).toBeNull()
    const aborted = new AbortController()
    aborted.abort()
    expect(await reranker.score('q', ['a'], aborted.signal)).toBeNull()
    expect(loader).not.toHaveBeenCalled()
  })

  it('returns null when the model gives the wrong number of scores', async () => {
    const loader: ModelLoader = async () => ({ score: async () => [1] })
    expect(await createLocalReranker(loader).score('q', ['a', 'b'])).toBeNull()
  })

  it('throws on a failed load, then backs off instead of retrying every call', async () => {
    let t = 0
    const loader = vi.fn(async () => {
      throw new Error('offline')
    })
    const reranker = createLocalReranker(loader, () => t)

    // The first failure surfaces; rerankChunks catches it and keeps fusion order.
    await expect(reranker.score('q', ['a'])).rejects.toThrow('offline')
    // Within the back-off: no load attempt, no scores.
    t = 30_000
    expect(await reranker.score('q', ['a'])).toBeNull()
    expect(loader).toHaveBeenCalledTimes(1)
    // After it: tries again.
    t = 61_000
    await expect(reranker.score('q', ['a'])).rejects.toThrow('offline')
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

describe('padBatch', () => {
  const enc = (ids: number[]) => ({
    ids,
    attention_mask: ids.map(() => 1),
    token_type_ids: ids.map((_, i) => (i >= 2 ? 1 : 0)),
  })

  it('pads every row to the longest, masking the padding', () => {
    const out = padBatch([enc([101, 7, 102]), enc([101, 7, 8, 9, 102])], 512)
    expect(out.length).toBe(5)
    expect(out.ids).toEqual([101, 7, 102, 0, 0, 101, 7, 8, 9, 102])
    expect(out.mask).toEqual([1, 1, 1, 0, 0, 1, 1, 1, 1, 1])
    expect(out.types).toEqual([0, 0, 1, 0, 0, 0, 0, 1, 1, 1])
  })

  it('truncates to the model limit but keeps the closing token', () => {
    const out = padBatch([enc([101, 1, 2, 3, 4, 5, 102])], 4)
    expect(out.length).toBe(4)
    expect(out.ids).toEqual([101, 1, 2, 102])
    expect(out.mask).toEqual([1, 1, 1, 1])
  })
})

describe('cachedModelFile', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rerank-cache-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('downloads on a miss, caches, and reads the cache after', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3])),
    ) as unknown as typeof fetch
    const first = await cachedModelFile(
      'org/m',
      'onnx/model.onnx',
      dir,
      fetchImpl,
    )
    const second = await cachedModelFile(
      'org/m',
      'onnx/model.onnx',
      dir,
      fetchImpl,
    )

    expect(Array.from(first)).toEqual([1, 2, 3])
    expect(Array.from(second)).toEqual([1, 2, 3])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://huggingface.co/org/m/resolve/main/onnx/model.onnx',
    )
    expect(
      Array.from(await readFile(join(dir, 'org/m/onnx/model.onnx'))),
    ).toEqual([1, 2, 3])
    // No partial file left behind.
    expect(await readdir(join(dir, 'org/m/onnx'))).toEqual(['model.onnx'])
  })

  it('throws on a failed download and caches nothing', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 404 }),
    ) as unknown as typeof fetch
    await expect(
      cachedModelFile('org/m', 'tokenizer.json', dir, fetchImpl),
    ).rejects.toThrow('404')
    await expect(readdir(join(dir, 'org/m'))).rejects.toThrow()
  })
})

describe('modelCacheDir', () => {
  it('keeps an absolute path and resolves a relative one against cwd', () => {
    expect(modelCacheDir('/models')).toBe('/models')
    expect(modelCacheDir('.cache/m')).toBe(`${process.cwd()}/.cache/m`)
  })
})
