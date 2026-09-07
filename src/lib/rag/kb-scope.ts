import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { knowledgeBases } from '@/db/schema'

/**
 * Resolve which knowledge bases a request may search.
 *
 * Deliberately NOT in `kb-actions.ts`. Every export of a `'use server'` module
 * is a browser-reachable endpoint, and this function takes an owner id as an
 * argument — exported from there, anyone could call it with someone else's id
 * and enumerate their knowledge bases. `server-only` makes importing it from a
 * client component a build error instead.
 *
 * Every id supplied by a caller is intersected with what the user actually
 * owns, so an unknown or someone else's id is silently dropped rather than
 * trusted.
 *
 * `requested === undefined` means "everything I own" — the default for a new
 * conversation. `requested === []` means the user deliberately selected none,
 * and stays empty. The two must never collapse into each other: an empty set
 * widening into "no filter" is the one silent failure mode spec 0028 is
 * written around (NFR3).
 */
export async function resolvePermittedKnowledgeBaseIds(
  userId: string,
  requested?: readonly string[],
): Promise<string[]> {
  const owned = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.ownerId, userId))
  const ownedIds = owned.map((r) => r.id)

  if (requested === undefined) return ownedIds
  const allowed = new Set(ownedIds)
  return requested.filter((id) => allowed.has(id))
}
