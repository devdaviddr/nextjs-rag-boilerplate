import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Switching the embedding model (spec 0040 FR3, #56, #64): a new generation
 * is built next to the active one and swapped in only when complete.
 */

const { s, createEmbeddings, embedPassages, refreshAiSettings, active } =
  vi.hoisted(() => ({
    s: {
      readGenerations: vi.fn(),
      countChunks: vi.fn(),
      insertBuilding: vi.fn(),
      claimBuilding: vi.fn(),
      renewBuilding: vi.fn(),
      releaseBuilding: vi.fn(),
      nextMissing: vi.fn(),
      insertVectors: vi.fn(),
      countEmbedded: vi.fn(),
      createIndex: vi.fn(),
      activate: vi.fn(),
      deleteGenerations: vi.fn(),
    },
    createEmbeddings: vi.fn(),
    embedPassages: vi.fn(),
    refreshAiSettings: vi.fn(async () => {}),
    active: {
      generationId: 'initial',
      model: 'nvidia/embed',
      dimensions: 2048,
    },
  }))

vi.mock('@/lib/rag/generations-store', () => s)
vi.mock('@/lib/rag/client', () => ({ createEmbeddings }))
vi.mock('@/lib/rag/embed', () => ({ embedPassages }))
vi.mock('@/lib/ai-settings', () => ({
  TTL_MS: 30_000,
  activeEmbedding: () => active,
  refreshAiSettings,
}))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  BUILD_BATCH,
  RETIRED_GRACE_MS,
  buildGeneration,
  cancelGeneration,
  startGeneration,
  sweepGenerations,
} from '@/lib/rag/generations'
import {
  createGenerationIndex,
  generationIndexName,
  generationLiteral,
  halfvecType,
} from '@/lib/rag/generation-sql'

const building = {
  id: 'gen-2',
  model: 'openai/text-embedding-3-large',
  dimensions: 3072,
  status: 'building',
  totalChunks: 3,
  embeddedChunks: 0,
  error: null,
  claimedAt: null,
  activatedAt: null,
  createdAt: new Date(0),
}

const chunk = (id: string) => ({
  chunkId: id,
  ownerId: 'u1',
  knowledgeBaseId: 'kb1',
  documentTitle: 'Handbook',
  heading: 'Leave',
  caption: null,
  content: `text ${id}`,
})

beforeEach(() => {
  for (const f of Object.values(s)) f.mockReset()
  createEmbeddings.mockReset()
  embedPassages.mockReset()
  refreshAiSettings.mockClear()
  s.readGenerations.mockResolvedValue([building])
  s.countChunks.mockResolvedValue(3)
  s.countEmbedded.mockResolvedValue(3)
  s.renewBuilding.mockResolvedValue(true)
  s.activate.mockResolvedValue(true)
  embedPassages.mockImplementation(async (texts: string[]) =>
    texts.map(() => [0.1, 0.2]),
  )
})

describe('startGeneration', () => {
  it('measures the model, then starts a building generation', async () => {
    createEmbeddings.mockResolvedValue([new Array(3072).fill(0)])
    s.insertBuilding.mockResolvedValue('gen-2')
    expect(await startGeneration(' openai/big ', 'admin-1')).toEqual({
      ok: true,
      generationId: 'gen-2',
      dimensions: 3072,
      totalChunks: 3,
    })
    // Asked of the NEW model, as a passage, not the active one.
    expect(createEmbeddings).toHaveBeenCalledWith(
      ['A test passage.'],
      'passage',
      undefined,
      'openai/big',
    )
    expect(s.insertBuilding).toHaveBeenCalledWith({
      model: 'openai/big',
      dimensions: 3072,
      totalChunks: 3,
      createdBy: 'admin-1',
    })
  })

  it('refuses a model whose vectors are too large to index', async () => {
    createEmbeddings.mockResolvedValue([new Array(4096).fill(0)])
    const result = await startGeneration('huge', null)
    expect(result).toEqual({
      ok: false,
      error:
        'huge returns 4096-dimensional vectors; the index takes 1 to 4000.',
    })
    expect(s.insertBuilding).not.toHaveBeenCalled()
  })

  it('refuses the model already in use, and a second re-index', async () => {
    expect((await startGeneration('nvidia/embed', null)).ok).toBe(false)
    createEmbeddings.mockResolvedValue([new Array(1024).fill(0)])
    s.insertBuilding.mockResolvedValue(null)
    const result = await startGeneration('other', null)
    expect(!result.ok && result.error).toContain('already running')
  })

  it('says so when the model does not answer', async () => {
    createEmbeddings.mockRejectedValue(new Error('HTTP 404'))
    const result = await startGeneration('missing', null)
    expect(!result.ok && result.error).toContain('HTTP 404')
  })
})

describe('buildGeneration', () => {
  it('does nothing when another worker holds the lease', async () => {
    s.claimBuilding.mockResolvedValue(false)
    await buildGeneration('gen-2')
    expect(s.nextMissing).not.toHaveBeenCalled()
  })

  it('embeds in batches with the new model, builds the index, then swaps', async () => {
    s.claimBuilding.mockResolvedValue(true)
    s.nextMissing
      .mockResolvedValueOnce([chunk('a'), chunk('b')])
      .mockResolvedValueOnce([chunk('c')])
      .mockResolvedValueOnce([])
    await buildGeneration('gen-2')

    expect(s.nextMissing).toHaveBeenCalledWith('gen-2', BUILD_BATCH)
    expect(embedPassages).toHaveBeenCalledWith(
      [expect.stringContaining('text a'), expect.stringContaining('text b')],
      { model: 'openai/text-embedding-3-large', dimensions: 3072 },
    )
    expect(s.insertVectors).toHaveBeenCalledTimes(2)
    expect(s.createIndex).toHaveBeenCalledWith('gen-2', 3072)
    expect(s.activate).toHaveBeenCalledWith('gen-2')
    // The index exists before the generation becomes searchable.
    expect(s.createIndex.mock.invocationCallOrder[0]).toBeLessThan(
      s.activate.mock.invocationCallOrder[0]!,
    )
    expect(refreshAiSettings).toHaveBeenCalledWith({ force: true })
  })

  it('embeds chunks that arrived during the build before swapping', async () => {
    s.claimBuilding.mockResolvedValue(true)
    s.nextMissing
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([chunk('late')])
      .mockResolvedValueOnce([])
    s.activate.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await buildGeneration('gen-2')
    expect(s.insertVectors).toHaveBeenCalledTimes(1)
    expect(s.activate).toHaveBeenCalledTimes(2)
  })

  it('pauses on an error, keeping it for Settings, and never swaps', async () => {
    s.claimBuilding.mockResolvedValue(true)
    s.nextMissing.mockResolvedValueOnce([chunk('a')])
    embedPassages.mockRejectedValueOnce(new Error('HTTP 429'))
    await buildGeneration('gen-2')
    expect(s.releaseBuilding).toHaveBeenCalledWith('gen-2', 'HTTP 429')
    expect(s.activate).not.toHaveBeenCalled()
  })

  it('stops when the re-index was cancelled', async () => {
    s.claimBuilding.mockResolvedValue(true)
    s.nextMissing.mockResolvedValue([chunk('a')])
    s.renewBuilding.mockResolvedValue(false)
    await buildGeneration('gen-2')
    expect(s.nextMissing).toHaveBeenCalledTimes(1)
    expect(s.activate).not.toHaveBeenCalled()
  })
})

describe('cancelGeneration and the sweep', () => {
  it('cancels only a building generation', async () => {
    await cancelGeneration('gen-2')
    expect(s.deleteGenerations).toHaveBeenCalledWith(['gen-2'])
    s.deleteGenerations.mockClear()
    await cancelGeneration('initial')
    expect(s.deleteGenerations).not.toHaveBeenCalled()
  })

  it('deletes a retired generation only after every instance has moved off it', async () => {
    const now = Date.now()
    const retired = { ...building, id: 'old', status: 'retired' }
    const activeRow = (msAgo: number) => ({
      ...building,
      id: 'new',
      status: 'active',
      activatedAt: new Date(now - msAgo),
    })
    s.readGenerations.mockResolvedValueOnce([retired, activeRow(1000)])
    await sweepGenerations()
    expect(s.deleteGenerations).not.toHaveBeenCalled()

    s.readGenerations.mockResolvedValueOnce([
      retired,
      activeRow(RETIRED_GRACE_MS + 1000),
    ])
    await sweepGenerations()
    expect(s.deleteGenerations).toHaveBeenCalledWith(['old'])
  })

  it('resumes a building generation', async () => {
    s.claimBuilding.mockResolvedValue(false)
    await sweepGenerations()
    expect(s.claimBuilding).toHaveBeenCalledWith('gen-2', expect.any(Number))
  })
})

describe('generation SQL', () => {
  it('writes the id and size as validated literals', () => {
    expect(generationIndexName('gen-2')).toBe('chunk_embeddings_gen_2_hnsw_idx')
    expect(() => generationLiteral("x'; DROP TABLE chunks; --")).toThrow()
    expect(() => halfvecType(4096)).toThrow()
    expect(() => halfvecType(1.5)).toThrow()
    const create = createGenerationIndex('gen-2', 3072) as unknown as {
      queryChunks: { value: string[] }[]
    }
    const text = create.queryChunks.flatMap((c) => c.value).join('')
    expect(text).toContain(`(("embedding"::halfvec(3072)) halfvec_cosine_ops)`)
    expect(text).toContain(`WHERE "generation_id" = 'gen-2'`)
  })
})
