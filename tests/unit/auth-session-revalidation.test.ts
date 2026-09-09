import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }))

vi.mock('@/db', () => ({ db: { query: { users: { findFirst } } } }))
vi.mock('@/db/schema', () => ({ users: { id: 'users.id' } }))

import {
  getUserPresence,
  needsRevalidation,
  SESSION_REVALIDATE_SECONDS,
} from '@/lib/auth/revalidate'

const NOW = 1_760_000_000

beforeEach(() => {
  findFirst.mockReset()
})

describe('needsRevalidation', () => {
  it('checks a token that has never been verified (FR3)', () => {
    expect(needsRevalidation(undefined, NOW)).toBe(true)
  })

  it('checks a token whose claim is not a usable number', () => {
    for (const bad of [null, 'yesterday', NaN, Infinity, {}]) {
      expect(needsRevalidation(bad, NOW)).toBe(true)
    }
  })

  it('skips a token verified inside the window (NFR1)', () => {
    expect(needsRevalidation(NOW - 1, NOW)).toBe(false)
    expect(needsRevalidation(NOW - (SESSION_REVALIDATE_SECONDS - 1), NOW)).toBe(
      false,
    )
  })

  it('checks again once the window has elapsed (FR2)', () => {
    expect(needsRevalidation(NOW - SESSION_REVALIDATE_SECONDS, NOW)).toBe(true)
    expect(needsRevalidation(NOW - SESSION_REVALIDATE_SECONDS * 10, NOW)).toBe(
      true,
    )
  })

  it('treats a future timestamp as unverified rather than fresh', () => {
    // Skewed clock or a doctored claim — either way it is not evidence of a
    // recent check, and must not buy the token an indefinite free pass.
    expect(needsRevalidation(NOW + 10_000, NOW)).toBe(true)
  })
})

describe('getUserPresence', () => {
  it('reports present when the row exists', async () => {
    findFirst.mockResolvedValue({ id: 'user-1' })
    await expect(getUserPresence('user-1')).resolves.toBe('present')
  })

  it('reports missing when the row is gone (FR1)', async () => {
    findFirst.mockResolvedValue(undefined)
    await expect(getUserPresence('ghost')).resolves.toBe('missing')
  })

  it('reports unknown — never missing — when the query throws (FR4)', async () => {
    // The whole point of the tri-state: an unreachable database must not read
    // as "this account was deleted" and log every user out.
    findFirst.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(getUserPresence('user-1')).resolves.toBe('unknown')
  })

  it('selects only the id, pulling no profile data into the token', async () => {
    findFirst.mockResolvedValue({ id: 'user-1' })
    await getUserPresence('user-1')
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      columns: { id: true },
    })
  })
})

/**
 * The jwt callback itself can't be imported here — `src/lib/auth/index.ts`
 * pulls in NextAuth, the providers and argon2. These cover the decision the
 * callback makes with the two units above, in the same order it makes them.
 */
describe('revalidation decision, as the jwt callback sequences it', () => {
  async function decide(token: { id?: string; verifiedAt?: number }) {
    if (!token.id || !needsRevalidation(token.verifiedAt, NOW)) {
      return { outcome: 'kept' as const, verifiedAt: token.verifiedAt }
    }
    const presence = await getUserPresence(token.id)
    if (presence === 'missing') return { outcome: 'invalidated' as const }
    return {
      outcome: 'kept' as const,
      verifiedAt: presence === 'present' ? NOW : token.verifiedAt,
    }
  }

  it('invalidates a session whose user no longer exists', async () => {
    findFirst.mockResolvedValue(undefined)
    expect(await decide({ id: 'ghost' })).toEqual({ outcome: 'invalidated' })
  })

  it('keeps a live session and stamps verifiedAt', async () => {
    findFirst.mockResolvedValue({ id: 'user-1' })
    expect(await decide({ id: 'user-1' })).toEqual({
      outcome: 'kept',
      verifiedAt: NOW,
    })
  })

  it('issues no query inside the throttle window', async () => {
    await decide({ id: 'user-1', verifiedAt: NOW - 5 })
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('issues exactly one query once the window has elapsed', async () => {
    findFirst.mockResolvedValue({ id: 'user-1' })
    await decide({ id: 'user-1', verifiedAt: NOW - SESSION_REVALIDATE_SECONDS })
    expect(findFirst).toHaveBeenCalledTimes(1)
  })

  it('keeps the session and leaves verifiedAt alone when the DB is down', async () => {
    findFirst.mockRejectedValue(new Error('ECONNREFUSED'))
    const stale = NOW - SESSION_REVALIDATE_SECONDS * 2
    expect(await decide({ id: 'user-1', verifiedAt: stale })).toEqual({
      outcome: 'kept',
      verifiedAt: stale, // untouched, so the check retries next request
    })
  })
})
