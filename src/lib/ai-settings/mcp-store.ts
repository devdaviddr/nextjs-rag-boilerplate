import 'server-only'

import { asc, eq } from 'drizzle-orm'

import { db } from '@/db'
import { type McpToolInfo, mcpServers } from '@/db/schema'

/** The `mcp_servers` table (spec 0048), kept apart like `./store`. */

export type McpServerRow = typeof mcpServers.$inferSelect

export async function readMcpServers(): Promise<McpServerRow[]> {
  return db.select().from(mcpServers).orderBy(asc(mcpServers.name))
}

export async function readMcpServer(
  id: string,
): Promise<McpServerRow | undefined> {
  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id))
  return row
}

export async function insertMcpServer(
  values: {
    name: string
    url: string
    internal: boolean
    token: { ciphertext: string; hint: string | null } | null
  },
  userId: string | null,
): Promise<string> {
  const [row] = await db
    .insert(mcpServers)
    .values({
      name: values.name,
      url: values.url,
      internal: values.internal,
      tokenCiphertext: values.token?.ciphertext ?? null,
      tokenHint: values.token?.hint ?? null,
      createdBy: userId,
    })
    .returning({ id: mcpServers.id })
  return row!.id
}

export async function updateMcpServer(
  id: string,
  values: Partial<{
    name: string
    url: string
    internal: boolean
    /** `null` removes the token; absent keeps it. */
    token: { ciphertext: string; hint: string | null } | null
    tools: McpToolInfo[]
    enabledTools: string[]
    toolsFetchedAt: Date
  }>,
): Promise<void> {
  const { token, ...rest } = values
  await db
    .update(mcpServers)
    .set({
      ...rest,
      ...(token !== undefined
        ? {
            tokenCiphertext: token?.ciphertext ?? null,
            tokenHint: token?.hint ?? null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(mcpServers.id, id))
}

export async function deleteMcpServer(id: string): Promise<void> {
  await db.delete(mcpServers).where(eq(mcpServers.id, id))
}
