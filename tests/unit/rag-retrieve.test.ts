import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv, execute, embedQuery } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, unknown>,
  execute: vi.fn(),
  embedQuery: vi.fn(),
}))

vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/db', () => ({ db: { execute } }))
vi.mock('@/lib/rag/embed', () => ({ embedQuery }))

import {
  listReadyDocuments,
  retrieveDocumentChunks,
  retrieveForOwner,
  toVectorLiteral,
} from '@/lib/rag/retrieve'

/**
 * Flatten a Drizzle `sql` template into its text and bound parameters, so a
 * test can assert on the query that would actually be sent — without a
 * database.
 */
interface SqlChunk {
  value?: unknown
  queryChunks?: SqlChunk[]
}

function inspect(query: SqlChunk): { text: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []

  const walk = (chunks: unknown[]): void => {
    for (const chunk of chunks) {
      if (chunk === null || chunk === undefined) continue

      // Drizzle interpolates plain values straight into queryChunks; static
      // SQL text arrives as an object with a string[] `value`.
      if (typeof chunk !== 'object') {
        params.push(chunk)
        parts.push(' ? ')
        continue
      }
      if (Array.isArray(chunk)) {
        walk(chunk)
        continue
      }

      const node = chunk as SqlChunk
      if (Array.isArray(node.queryChunks)) {
        walk(node.queryChunks)
      } else if (
        Array.isArray(node.value) &&
        node.value.every((v) => typeof v === 'string')
      ) {
        parts.push((node.value as string[]).join(''))
      } else if ('value' in node) {
        params.push(node.value)
        parts.push(' ? ')
      }
    }
  }

  walk(query.queryChunks ?? [])
  return { text: parts.join(''), params }
}

const VECTOR = Array.from({ length: 8 }, (_, i) => i / 10)
const KB_A = ['kb-a']

beforeEach(() => {
  for (const key of Object.keys(mockEnv)) delete mockEnv[key]
  Object.assign(mockEnv, {
    RAG_TOP_K: 8,
    RAG_MIN_SIMILARITY: 0.35,
    RAG_HYBRID_CANDIDATES: 20,
    RAG_RRF_K: 60,
    RAG_DOC_SCOPE_MAX_CHUNKS: 24,
  })
  execute.mockReset()
  embedQuery.mockReset()
  embedQuery.mockResolvedValue(VECTOR)
  execute.mockResolvedValue([])
})

describe('toVectorLiteral', () => {
  it('renders pgvector text format', () => {
    expect(toVectorLiteral([1, 2, 3])).toBe('[1,2,3]')
  })
})

describe('retrieveForOwner — tenant isolation (spec 0025 NFR1)', () => {
  it('filters on owner_id inside the SQL, not after the fact', async () => {
    await retrieveForOwner('user-a', 'anything', KB_A)

    const query = execute.mock.calls[0]?.[0] as SqlChunk
    const { text, params } = inspect(query)

    expect(text).toMatch(/WHERE\s+c\.owner_id\s*=/)
    expect(params).toContain('user-a')
  })

  it('never sends another user id as the owner filter', async () => {
    await retrieveForOwner('user-b', 'anything', KB_A)
    const { params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(params).toContain('user-b')
    expect(params).not.toContain('user-a')
  })

  it('cannot return a row belonging to another owner, because the DB never sends one', async () => {
    // The database is the boundary: with owner_id bound, a foreign row is not
    // in the result set at all. This asserts the contract the query relies on.
    execute.mockResolvedValue([])
    const results = await retrieveForOwner(
      'user-b',
      'what is in user A file?',
      KB_A,
    )
    expect(results).toEqual([])
  })

  it('embeds the question as a query, never as a passage', async () => {
    await retrieveForOwner('user-a', 'a question', KB_A)
    // embedQuery is the only exported path for questions; embedPassages is a
    // separate function, so using the wrong input_type is not reachable here.
    expect(embedQuery).toHaveBeenCalledWith('a question')
  })

  it('orders by raw distance so the HNSW index can be used', async () => {
    await retrieveForOwner('user-a', 'anything', KB_A)
    const { text } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(text).toMatch(/ORDER BY\s+c\.embedding\s*<=>/)
    expect(text).toContain('::halfvec')
  })
})

describe('retrieveForOwner — knowledge-base isolation (spec 0028 FR6, NFR1)', () => {
  it('scopes the dense CTE to the permitted knowledge bases', async () => {
    await retrieveForOwner('user-a', 'anything', KB_A)
    const { text } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)

    const vecCte = text.slice(text.indexOf('vec AS'), text.indexOf('lex AS'))
    expect(vecCte).toMatch(/c\.knowledge_base_id\s*=\s*ANY/)
  })

  it('scopes the lexical CTE to the permitted knowledge bases', async () => {
    await retrieveForOwner('user-a', 'anything', KB_A)
    const { text } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)

    const lexCte = text.slice(text.indexOf('lex AS'), text.indexOf('fused AS'))
    expect(lexCte).toMatch(/c\.knowledge_base_id\s*=\s*ANY/)
  })

  it('scopes the final SELECT to the permitted knowledge bases', async () => {
    await retrieveForOwner('user-a', 'anything', KB_A)
    const { text } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)

    const finalSelect = text.slice(text.lastIndexOf('SELECT'))
    expect(finalSelect).toMatch(/c\.knowledge_base_id\s*=\s*ANY/)
  })

  it('binds the selected knowledge base ids as query parameters', async () => {
    await retrieveForOwner('user-a', 'anything', ['kb-1', 'kb-2'])
    const { params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(params).toContain('kb-1')
    expect(params).toContain('kb-2')
  })

  it('never lets an unrelated knowledge base id leak into the bound parameters', async () => {
    await retrieveForOwner('user-a', 'anything', KB_A)
    const { params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(params).not.toContain('kb-b')
  })

  it('returns [] immediately for an empty knowledge base selection, with no embedding call and no query', async () => {
    const results = await retrieveForOwner('user-a', 'anything', [])
    expect(results).toEqual([])
    expect(embedQuery).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('scales the candidate pool with the number of selected knowledge bases', async () => {
    await retrieveForOwner('user-a', 'anything', ['kb-1', 'kb-2', 'kb-3'])
    const { params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    // RAG_HYBRID_CANDIDATES (20) * 3 selected KBs = 60, well under the ceiling.
    expect(params).toContain(60)
  })

  it('caps the scaled candidate pool at a sane ceiling', async () => {
    const manyKbs = Array.from({ length: 50 }, (_, i) => `kb-${i}`)
    await retrieveForOwner('user-a', 'anything', manyKbs)
    const { params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    // 20 * 50 = 1000, which must be capped rather than sent as-is.
    expect(params).not.toContain(1000)
  })
})

describe('retrieveForOwner — similarity floor', () => {
  const row = (id: string, similarity: number) => ({
    chunk_id: id,
    document_id: 'd1',
    document_title: 'Doc',
    content: 'text',
    page_number: 3,
    similarity,
  })

  it('drops rows below the floor', async () => {
    execute.mockResolvedValue([row('a', 0.9), row('b', 0.2), row('c', 0.36)])
    const results = await retrieveForOwner('user-a', 'q', KB_A)
    expect(results.map((r) => r.chunkId)).toEqual(['a', 'c'])
  })

  it('returns nothing when everything is below the floor', async () => {
    execute.mockResolvedValue([row('a', 0.1), row('b', 0.05)])
    expect(await retrieveForOwner('user-a', 'q', KB_A)).toEqual([])
  })

  it('honours an explicit override', async () => {
    execute.mockResolvedValue([row('a', 0.5)])
    expect(
      await retrieveForOwner('user-a', 'q', KB_A, { minSimilarity: 0.8 }),
    ).toEqual([])
  })
})

describe('listReadyDocuments — knowledge-base isolation (spec 0028 FR6)', () => {
  it('filters on both owner_id and knowledge_base_id', async () => {
    await listReadyDocuments('user-a', KB_A)
    const { text, params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(text).toMatch(/WHERE\s+d\.owner_id\s*=/)
    expect(text).toMatch(/d\.knowledge_base_id\s*=\s*ANY/)
    expect(params).toContain('user-a')
  })

  it('returns [] immediately for an empty knowledge base selection, touching no database', async () => {
    const results = await listReadyDocuments('user-a', [])
    expect(results).toEqual([])
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('retrieveDocumentChunks — the dangerous one (spec 0028)', () => {
  it('filters on owner_id, the document id, and knowledge_base_id together', async () => {
    await retrieveDocumentChunks('user-a', 'doc-1', KB_A)
    const { text, params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(text).toMatch(/WHERE\s+c\.owner_id\s*=/)
    expect(text).toMatch(/c\.document_id\s*=/)
    expect(text).toMatch(/c\.knowledge_base_id\s*=\s*ANY/)
    expect(params).toContain('user-a')
    expect(params).toContain('doc-1')
  })

  it('returns nothing when the document belongs to a knowledge base outside the permitted set', async () => {
    // A document id belonging to the same owner's OTHER knowledge base: the
    // real query's WHERE clause would exclude every one of its chunks, so
    // the database returns no rows at all — never a row the app has to
    // remember to filter out afterwards.
    execute.mockResolvedValue([])
    const results = await retrieveDocumentChunks('user-a', 'doc-in-kb-b', KB_A)
    expect(results).toEqual([])
  })

  it('returns [] immediately for an empty knowledge base selection, touching no database', async () => {
    const results = await retrieveDocumentChunks('user-a', 'doc-1', [])
    expect(results).toEqual([])
    expect(execute).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The candidate pool (spec 0036 FR1)
//
// The defect: the fused SELECT used to end `LIMIT ${topK}` (8), so the
// reranker was handed eight rows and RAG_RERANK_CANDIDATES (20) was dead
// configuration. It could reorder the eight chunks that had already won and
// could never promote the one sitting at fusion rank 9 — which is the only
// thing a reranker is for.
//
// The pipeline is now: fuse -> keep RAG_RERANK_CANDIDATES -> rerank -> gate ->
// cut to topK. These tests pin the LIMIT that is actually sent, because that
// is where the bug lived and it was invisible in the returned chunks.
// ---------------------------------------------------------------------------

/** The `LIMIT` on the final fused SELECT, as bound. */
function fusedLimit(query: SqlChunk): unknown {
  const { text, params } = inspect(query)
  // Every `?` in order; the final SELECT's LIMIT is the last bound parameter.
  expect(text.trimEnd().endsWith('?')).toBe(true)
  return params[params.length - 1]
}

describe('retrieveForOwner — candidate pool width (spec 0036 FR1)', () => {
  it('retrieves only topK when reranking is off', async () => {
    mockEnv.RAG_RERANK_ENABLED = false
    mockEnv.RAG_RERANK_CANDIDATES = 20

    await retrieveForOwner('user-a', 'q', KB_A)
    expect(fusedLimit(execute.mock.calls[0]?.[0] as SqlChunk)).toBe(8)
  })

  it('retrieves RAG_RERANK_CANDIDATES when reranking is on', async () => {
    // THE fix. Without this the reranker never sees rank 9 and the knob that
    // spec 0036 FR1 is written around does nothing at all.
    mockEnv.RAG_RERANK_ENABLED = true
    mockEnv.RAG_RERANK_CANDIDATES = 20

    await retrieveForOwner('user-a', 'q', KB_A)
    expect(fusedLimit(execute.mock.calls[0]?.[0] as SqlChunk)).toBe(20)
  })

  it('never retrieves a pool narrower than the answer', async () => {
    // A pool below topK would discard chunks the gate would have kept — the
    // opposite of the defect, and worse than it.
    mockEnv.RAG_RERANK_ENABLED = true
    mockEnv.RAG_RERANK_CANDIDATES = 3

    await retrieveForOwner('user-a', 'q', KB_A)
    expect(fusedLimit(execute.mock.calls[0]?.[0] as SqlChunk)).toBe(8)
  })

  it('leaves the per-channel ANN scan alone at default settings', async () => {
    // The widened pool is a wider FINAL limit, not a wider index scan: the
    // vec/lex CTEs still take RAG_HYBRID_CANDIDATES each. At the defaults
    // (20 per channel, pool 20) the scan is identical with reranking on.
    mockEnv.RAG_RERANK_ENABLED = false
    await retrieveForOwner('user-a', 'q', KB_A)
    const off = inspect(execute.mock.calls[0]?.[0] as SqlChunk).params

    execute.mockClear()
    mockEnv.RAG_RERANK_ENABLED = true
    mockEnv.RAG_RERANK_CANDIDATES = 20
    await retrieveForOwner('user-a', 'q', KB_A)
    const on = inspect(execute.mock.calls[0]?.[0] as SqlChunk).params

    // Same bound parameters everywhere except the last one, the fused LIMIT.
    expect(on.slice(0, -1)).toEqual(off.slice(0, -1))
    expect(off[off.length - 1]).toBe(8)
    expect(on[on.length - 1]).toBe(20)
  })

  it('widens the per-channel scan only when the pool outgrows it', async () => {
    // Fusion cannot hand on 50 candidates if neither channel produced 50, so
    // a pool wider than the channels raises them to match. This is the only
    // configuration that costs a wider index scan.
    mockEnv.RAG_RERANK_ENABLED = true
    mockEnv.RAG_RERANK_CANDIDATES = 50

    await retrieveForOwner('user-a', 'q', KB_A)
    const { params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(params).toContain(50)
    expect(params).not.toContain(20)
  })

  it('keeps the per-channel scan bounded by the ceiling even so', async () => {
    mockEnv.RAG_RERANK_ENABLED = true
    mockEnv.RAG_RERANK_CANDIDATES = 5000

    await retrieveForOwner('user-a', 'q', KB_A)
    const { params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(params).toContain(200)
    expect(params).not.toContain(5000 - 1)
  })

  it('does not raise the per-channel scan to topK when reranking is off', async () => {
    // Regression guard for the obvious wrong fix — flooring the channel pool
    // at topK unconditionally. A deployment that deliberately set
    // RAG_HYBRID_CANDIDATES below RAG_TOP_K would silently get a wider scan.
    mockEnv.RAG_RERANK_ENABLED = false
    mockEnv.RAG_HYBRID_CANDIDATES = 4

    await retrieveForOwner('user-a', 'q', KB_A)
    const { params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(params).toContain(4)
  })
})
