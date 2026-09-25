import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /api/citations/[chunkId] (spec 0035), and its section-parent branch
 * (spec 0033 1c). The pure `parentRunBoxes` is pinned in rag-parents.test.ts;
 * this pins the route around it: that `?parent=1` is what switches to the run's
 * boxes, and that the page's rows are read under the owner predicate, because
 * the chunk id came from a client.
 */

const { getCurrentSession, queries } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  // One entry per `db.select(...)` call, in order: the rows it resolves to,
  // and the arguments each builder method was called with.
  queries: [] as { rows: unknown[]; calls: Record<string, unknown[]> }[],
}))

vi.mock('@/lib/auth/session', () => ({ getCurrentSession }))

// Conditions become plain values, so a test can read the WHERE clause.
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  and: (...conditions: unknown[]) => ({ and: conditions }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  asc: (column: unknown) => ({ asc: column }),
}))

vi.mock('@/db', () => {
  let next = 0
  return {
    db: {
      select: () => {
        const query = queries[next++]
        if (!query) throw new Error('unexpected query')
        const builder: Record<string, unknown> = {}
        for (const method of [
          'from',
          'innerJoin',
          'where',
          'limit',
          'orderBy',
        ]) {
          builder[method] = (...args: unknown[]) => {
            query.calls[method] = args
            return builder
          }
        }
        builder.then = (resolve: (rows: unknown[]) => unknown) =>
          resolve(query.rows)
        return builder
      },
      __reset: () => {
        next = 0
      },
    },
  }
})

import { db } from '@/db'
import { chunks } from '@/db/schema'
import { GET } from '@/app/api/citations/[chunkId]/route'

const R1 = { xmin: 0.1, ymin: 0.15, xmax: 0.45, ymax: 0.2 }
const R2 = { xmin: 0.55, ymin: 0.15, xmax: 0.9, ymax: 0.2 }
const R3 = { xmin: 0.1, ymin: 0.6, xmax: 0.9, ymax: 0.7 }
const HEAD = { xmin: 0.1, ymin: 0.1, xmax: 0.5, ymax: 0.12 }

const chunkRow = {
  documentId: 'doc-1',
  pageNumber: 2,
  pageCount: 5,
  kind: 'text',
  bbox: null,
  boxes: [R1],
}

// Run "Retention" = a, b; then "Disposal" = c.
const pageRows = [
  {
    id: 'a',
    kind: 'text',
    heading: 'Retention',
    headingBbox: HEAD,
    chunkIndex: 0,
    boxes: [R1],
    bbox: null,
  },
  {
    id: 'b',
    kind: 'text',
    heading: 'Retention',
    headingBbox: HEAD,
    chunkIndex: 1,
    boxes: [R2],
    bbox: null,
  },
  {
    id: 'c',
    kind: 'text',
    heading: 'Disposal',
    headingBbox: R3,
    chunkIndex: 2,
    boxes: [R3],
    bbox: null,
  },
]

function stub(...rows: unknown[][]) {
  queries.length = 0
  for (const r of rows) queries.push({ rows: r, calls: {} })
  ;(db as unknown as { __reset: () => void }).__reset()
}

async function get(chunkId: string, query = '') {
  return GET(new Request(`http://localhost/api/citations/${chunkId}${query}`), {
    params: Promise.resolve({ chunkId }),
  })
}

describe('GET /api/citations/[chunkId]', () => {
  beforeEach(() => {
    getCurrentSession.mockResolvedValue({ user: { id: 'user-1' } })
  })

  it('returns the chunk’s own boxes and reads no page when not a parent', async () => {
    stub([chunkRow])
    const response = await get('a')
    expect(response.status).toBe(200)
    expect((await response.json()).boxes).toEqual([R1])
    expect(queries[0]?.calls.where?.[0]).toEqual({
      and: [{ eq: [chunks.id, 'a'] }, { eq: [chunks.ownerId, 'user-1'] }],
    })
  })

  it('returns every box of the run for ?parent=1, as a list', async () => {
    stub([chunkRow], pageRows)
    const response = await get('a', '?parent=1')
    const body = await response.json()
    expect(body.boxes).toEqual([R1, R2])
    expect(body.pageNumber).toBe(2)
  })

  it('reads the page’s rows under the owner predicate', async () => {
    stub([chunkRow], pageRows)
    await get('a', '?parent=1')
    const where = queries[1]?.calls.where?.[0] as { and: unknown[] }
    expect(where.and).toContainEqual({ eq: [chunks.ownerId, 'user-1'] })
    expect(where.and).toContainEqual({ eq: [chunks.documentId, 'doc-1'] })
    expect(where.and).toContainEqual({ eq: [chunks.pageNumber, 2] })
  })

  it('keeps the chunk’s own boxes when the chunk is in no run', async () => {
    stub([chunkRow], [])
    const response = await get('a', '?parent=1')
    expect((await response.json()).boxes).toEqual([R1])
  })

  it('404s for a chunk that is not the caller’s, before reading any page', async () => {
    stub([])
    const response = await get('a', '?parent=1')
    expect(response.status).toBe(404)
  })

  it('401s without a session', async () => {
    getCurrentSession.mockResolvedValue(null)
    stub()
    const response = await get('a')
    expect(response.status).toBe(401)
  })
})
