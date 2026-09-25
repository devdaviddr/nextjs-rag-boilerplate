import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /api/chat/activity (spec 0042 FR12): a past answer's activity, for its
 * owner or an admin only; details for admins only. The database is replaced
 * by rows per table.
 */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as null | { user: { id: string; roles: string[] } },
    tables: {} as Record<string, unknown[]>,
  },
}))

vi.mock('@/lib/auth/session', () => ({
  getCurrentSession: async () => state.session,
}))
vi.mock('@/db/schema', () => ({
  messages: { __name: 'messages', ownerId: {}, requestId: {}, role: {} },
  ragRuns: { __name: 'ragRuns', id: {}, startedAt: {}, durationMs: {} },
  ragSpans: { __name: 'ragSpans', runId: {}, key: {} },
  appLogs: { __name: 'appLogs', requestId: {}, id: {} },
}))
vi.mock('drizzle-orm', () => ({
  and: () => ({}),
  asc: () => ({}),
  eq: () => ({}),
}))
vi.mock('@/db', () => {
  const chain = (rows: unknown[]) => {
    const q = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
    }
    return q
  }
  return {
    db: {
      select: () => ({
        from: (table: { __name: string }) =>
          chain(state.tables[table.__name] ?? []),
      }),
    },
  }
})

import { GET } from '@/app/api/chat/activity/route'

const REQ = 'req-1234567890'
const get = () =>
  GET(new Request(`http://x/api/chat/activity?requestId=${REQ}`))

beforeEach(() => {
  state.session = null
  state.tables = {
    messages: [{ ownerId: 'owner' }],
    ragRuns: [
      { startedAt: new Date('2026-09-26T00:00:00Z'), durationMs: 5_000 },
    ],
    ragSpans: [
      {
        key: 1,
        parentKey: null,
        name: 'retrieve',
        startedAt: new Date('2026-09-26T00:00:00.500Z'),
        durationMs: 1_200,
        status: 'ok',
        model: null,
        tokens: null,
      },
    ],
    appLogs: [
      {
        time: new Date('2026-09-26T00:00:01Z'),
        level: 'info',
        category: 'agent',
        message: 'Planner chose to search',
        meta: { query: 'leave' },
      },
      {
        time: new Date('2026-09-26T00:00:02Z'),
        level: 'info',
        category: 'agent',
        message: 'Agentic trace',
        meta: {},
      },
    ],
  }
})

describe('GET /api/chat/activity', () => {
  it('is for signed-in people only', async () => {
    expect((await get()).status).toBe(401)
  })

  it('hides someone else’s answer as if it did not exist', async () => {
    state.session = { user: { id: 'stranger', roles: [] } }
    expect((await get()).status).toBe(404)
  })

  it('gives the owner plain lines and steps, without details', async () => {
    state.session = { user: { id: 'owner', roles: [] } }
    const res = await get()
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      steps: { name: string; offsetMs: number }[]
      lines: { text: string; detail?: unknown }[]
    }
    expect(body.steps).toEqual([
      expect.objectContaining({ name: 'retrieve', offsetMs: 500 }),
    ])
    expect(body.lines).toEqual([
      expect.objectContaining({ text: 'Decided to search for “leave”' }),
    ])
    expect(body.lines[0]).not.toHaveProperty('detail')
  })

  it('gives an admin any answer, with details', async () => {
    state.session = { user: { id: 'admin', roles: ['admin'] } }
    const body = (await (await get()).json()) as {
      lines: { detail?: Record<string, unknown> }[]
    }
    expect(body.lines[0]?.detail).toMatchObject({ query: 'leave' })
  })

  it('rejects a malformed id without a query', async () => {
    state.session = { user: { id: 'owner', roles: [] } }
    const res = await GET(
      new Request('http://x/api/chat/activity?requestId=%27;drop'),
    )
    expect(res.status).toBe(404)
  })
})
