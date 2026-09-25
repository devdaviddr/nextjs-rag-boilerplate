import 'server-only'

import { eq, like } from 'drizzle-orm'

import { db } from '@/db'
import { aiConnections, aiSettings } from '@/db/schema'

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

export async function readConnectionRows() {
  return db
    .select({
      id: aiConnections.id,
      name: aiConnections.name,
      preset: aiConnections.preset,
      baseUrl: aiConnections.baseUrl,
      apiKeyCiphertext: aiConnections.apiKeyCiphertext,
      apiKeyHint: aiConnections.apiKeyHint,
    })
    .from(aiConnections)
}

export interface ConnectionWrite {
  name: string
  preset: string
  baseUrl: string
  /** Undefined keeps the stored key; null removes it. */
  apiKey?: { ciphertext: string; hint: string | null } | null
}

export async function insertConnection(
  values: ConnectionWrite,
  userId: string | null,
): Promise<string> {
  const [row] = await db
    .insert(aiConnections)
    .values({
      name: values.name,
      preset: values.preset,
      baseUrl: values.baseUrl,
      apiKeyCiphertext: values.apiKey?.ciphertext ?? null,
      apiKeyHint: values.apiKey?.hint ?? null,
      createdBy: userId,
    })
    .returning({ id: aiConnections.id })
  return row!.id
}

export async function updateConnection(
  id: string,
  values: ConnectionWrite,
): Promise<boolean> {
  const set: Partial<typeof aiConnections.$inferInsert> = {
    name: values.name,
    preset: values.preset,
    baseUrl: values.baseUrl,
    updatedAt: new Date(),
  }
  if (values.apiKey !== undefined) {
    set.apiKeyCiphertext = values.apiKey?.ciphertext ?? null
    set.apiKeyHint = values.apiKey?.hint ?? null
  }
  const rows = await db
    .update(aiConnections)
    .set(set)
    .where(eq(aiConnections.id, id))
    .returning({ id: aiConnections.id })
  return rows.length > 0
}

/** Delete a connection and point any job that used it back at `.env`. */
export async function deleteConnection(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const using = await tx
      .select({ key: aiSettings.key, value: aiSettings.value })
      .from(aiSettings)
      .where(like(aiSettings.key, 'connection:%'))
    for (const row of using) {
      if (row.value === id) {
        await tx.delete(aiSettings).where(eq(aiSettings.key, row.key))
      }
    }
    await tx.delete(aiConnections).where(eq(aiConnections.id, id))
  })
}
