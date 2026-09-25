import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { aiSettings } from '@/db/schema'

/**
 * The `ai_settings` table, and nothing else. Kept apart from the resolver so
 * its tests can replace the database with a map (spec 0040 FR6).
 */

export interface SavedRow {
  key: string
  value: string
}

export async function readSavedRows(): Promise<SavedRow[]> {
  return db
    .select({ key: aiSettings.key, value: aiSettings.value })
    .from(aiSettings)
}

export async function writeSavedRow(
  key: string,
  value: string,
  userId: string | null,
): Promise<void> {
  const updatedAt = new Date()
  await db
    .insert(aiSettings)
    .values({ key, value, updatedBy: userId, updatedAt })
    .onConflictDoUpdate({
      target: aiSettings.key,
      set: { value, updatedBy: userId, updatedAt },
    })
}

export async function deleteSavedRow(key: string): Promise<void> {
  await db.delete(aiSettings).where(eq(aiSettings.key, key))
}
