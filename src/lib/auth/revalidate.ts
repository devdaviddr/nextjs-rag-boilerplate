import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { users } from '@/db/schema'

/**
 * Session revalidation against the `users` table (spec 0030).
 *
 * A JWT session is trusted on its signature alone, so a token outlives the row
 * it names: delete the account, restore an older backup, or point the same
 * `AUTH_SECRET` at a second database, and the holder stays "signed in" as a
 * user that does not exist. Route protection passes, the UI renders as
 * authenticated, and the first write dies on a foreign key with a 500 the user
 * cannot act on.
 */

/**
 * How long a verified session is trusted before the user row is re-checked.
 *
 * Not an env var: it trades a bounded window of stale access against a
 * database query on every authenticated request, and that trade shouldn't
 * differ per deployment. Five minutes keeps steady-state reads free (NFR1)
 * while bounding how long a deleted user keeps access.
 */
export const SESSION_REVALIDATE_SECONDS = 300

/**
 * Tri-state on purpose. A failed query is `unknown`, NOT `missing` — treating
 * an unreachable database as proof of deletion would turn a brief outage into
 * a mass logout of every signed-in user.
 */
export type UserPresence = 'present' | 'missing' | 'unknown'

/** Whether the token is due a `users` lookup. */
export function needsRevalidation(
  verifiedAt: unknown,
  nowSeconds: number,
  intervalSeconds: number = SESSION_REVALIDATE_SECONDS,
): boolean {
  // Never checked — a token issued before this existed. Check it now, so
  // ghost cookies already in the wild self-heal on next use (FR3).
  if (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt))
    return true
  // A timestamp in the future is a skewed clock or a doctored claim; either
  // way it is not evidence of a recent check.
  if (verifiedAt > nowSeconds) return true
  return nowSeconds - verifiedAt >= intervalSeconds
}

/** Does this user id still have a row? See `UserPresence` on the third state. */
export async function getUserPresence(userId: string): Promise<UserPresence> {
  try {
    const row = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true },
    })
    return row ? 'present' : 'missing'
  } catch {
    return 'unknown'
  }
}
