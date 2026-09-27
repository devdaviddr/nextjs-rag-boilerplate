import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { files } from '@/db/schema'
import { deleteObject } from './client'

/**
 * Delete every S3 object owned by a user. Used by `admin-actions.ts`'s
 * `deleteUser` BEFORE the user row is deleted — the DB foreign key cascades
 * the `files` rows automatically, but never the underlying S3 objects, so
 * those must be removed explicitly while their bucket keys are still known.
 *
 * Deliberately NOT in `actions.ts`. Every export of a `'use server'` module
 * is a browser-reachable endpoint, and this function takes a user id and does
 * no authorisation of its own — the caller (`deleteUser`) is admin-checked.
 * `server-only` makes importing it from a client component a build error.
 */
export async function deleteAllFilesForUser(userId: string): Promise<void> {
  const rows = await db.query.files.findMany({
    where: eq(files.ownerId, userId),
    columns: { bucketKey: true },
  })
  await Promise.all(rows.map((r) => deleteObject(r.bucketKey)))
}
