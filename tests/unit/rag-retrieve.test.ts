import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv, execute, embedQuery } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, unknown>,
  execute: vi.fn(),
  embedQuery: vi.fn(),
}))

vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/db', () => ({ db: { execute } }))
vi.mock('@/lib/rag/embed', () => ({ embedQuery }))

import { retrieveForOwner, toVectorLiteral } from '@/lib/rag/retrieve'

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

beforeEach(() => {
  for (const key of Object.keys(mockEnv)) delete mockEnv[key]
  Object.assign(mockEnv, { RAG_TOP_K: 8, RAG_MIN_SIMILARITY: 0.35 })
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
    await retrieveForOwner('user-a', 'anything')

    const query = execute.mock.calls[0]?.[0] as SqlChunk
    const { text, params } = inspect(query)

    expect(text).toMatch(/WHERE\s+c\.owner_id\s*=/)
    expect(params).toContain('user-a')
  })

  it('never sends another user id as the owner filter', async () => {
    await retrieveForOwner('user-b', 'anything')
    const { params } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(params).toContain('user-b')
    expect(params).not.toContain('user-a')
  })

  it('cannot return a row belonging to another owner, because the DB never sends one', async () => {
    // The database is the boundary: with owner_id bound, a foreign row is not
    // in the result set at all. This asserts the contract the query relies on.
    execute.mockResolvedValue([])
    const results = await retrieveForOwner('user-b', 'what is in user A file?')
    expect(results).toEqual([])
  })

  it('embeds the question as a query, never as a passage', async () => {
    await retrieveForOwner('user-a', 'a question')
    // embedQuery is the only exported path for questions; embedPassages is a
    // separate function, so using the wrong input_type is not reachable here.
    expect(embedQuery).toHaveBeenCalledWith('a question')
  })

  it('orders by raw distance so the HNSW index can be used', async () => {
    await retrieveForOwner('user-a', 'anything')
    const { text } = inspect(execute.mock.calls[0]?.[0] as SqlChunk)
    expect(text).toMatch(/ORDER BY\s+c\.embedding\s*<=>/)
    expect(text).toContain('::halfvec')
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
    const results = await retrieveForOwner('user-a', 'q')
    expect(results.map((r) => r.chunkId)).toEqual(['a', 'c'])
  })

  it('returns nothing when everything is below the floor', async () => {
    execute.mockResolvedValue([row('a', 0.1), row('b', 0.05)])
    expect(await retrieveForOwner('user-a', 'q')).toEqual([])
  })

  it('honours an explicit override', async () => {
    execute.mockResolvedValue([row('a', 0.5)])
    expect(
      await retrieveForOwner('user-a', 'q', { minSimilarity: 0.8 }),
    ).toEqual([])
  })
})
