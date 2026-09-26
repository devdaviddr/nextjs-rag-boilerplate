import 'server-only'

import { desc, eq, like } from 'drizzle-orm'

import { db } from '@/db'
import { aiConnections, aiSettings, aiSettingsAudit, users } from '@/db/schema'

/**
 * The `ai_settings` table, and nothing else. Kept apart from the resolver so
 * its tests can replace the database with a map (spec 0040 FR6).
 */

export interface SavedRow {
  key: string
  value: string
  /** Who saved it and when, for the "saved" badge (spec 0040 FR5). */
  updatedBy?: string | null
  updatedAt?: Date | null
}

export async function readSavedRows(): Promise<SavedRow[]> {
  return db
    .select({
      key: aiSettings.key,
      value: aiSettings.value,
      updatedBy: users.name,
      updatedByEmail: users.email,
      updatedAt: aiSettings.updatedAt,
    })
    .from(aiSettings)
    .leftJoin(users, eq(users.id, aiSettings.updatedBy))
    .then((rows) =>
      rows.map(({ updatedByEmail, ...row }) => ({
        ...row,
        updatedBy: row.updatedBy ?? updatedByEmail,
      })),
    )
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

/** One change for the audit log (spec 0040 FR5). Never a secret. */
export interface AuditWrite {
  action:
    | 'save'
    | 'reset'
    | 'connection-add'
    | 'connection-edit'
    | 'connection-remove'
  key: string
  oldValue: string | null
  newValue: string | null
}

export async function writeAudit(
  entry: AuditWrite,
  userId: string | null,
): Promise<void> {
  await db.insert(aiSettingsAudit).values({ ...entry, userId })
}

export interface AuditRow extends AuditWrite {
  at: Date
  by: string | null
}

/** The latest changes, newest first. */
export async function readRecentAudit(limit: number): Promise<AuditRow[]> {
  const rows = await db
    .select({
      at: aiSettingsAudit.at,
      action: aiSettingsAudit.action,
      key: aiSettingsAudit.key,
      oldValue: aiSettingsAudit.oldValue,
      newValue: aiSettingsAudit.newValue,
      name: users.name,
      email: users.email,
    })
    .from(aiSettingsAudit)
    .leftJoin(users, eq(users.id, aiSettingsAudit.userId))
    .orderBy(desc(aiSettingsAudit.at), desc(aiSettingsAudit.id))
    .limit(limit)
  return rows.map(({ name, email, ...row }) => ({
    ...row,
    action: row.action as AuditWrite['action'],
    by: name ?? email,
  }))
}
