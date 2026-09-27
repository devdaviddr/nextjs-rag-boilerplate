import 'server-only'

import { z } from 'zod'

import { db } from '@/db'
import { type McpToolInfo, mcpServers } from '@/db/schema'
import { decryptSecret } from '@/lib/ai-settings/crypto'
import { logger } from '@/lib/logger'
import { callMcpTool } from './mcp-client'
import type { AnyAgentTool } from './types'

/** The longest one MCP call may take, within the loop's own budget (FR4). */
export const MCP_CALL_MS = 20_000

/** `Ticket Search!` → `ticket_search`: the server's part of a tool name. */
export function slug(name: string, max = 20): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, max)
      .replace(/_+$/, '') || 'server'
  )
}

/** `mcp_<server>_<tool>`, within the 64 characters tool names allow (FR3). */
export function mcpToolName(server: string, tool: string): string {
  const safeTool = tool.replace(/[^A-Za-z0-9_-]/g, '_')
  return `mcp_${slug(server)}_${safeTool}`.slice(0, 64)
}

/**
 * The server's JSON Schema as a validator (FR3), so arguments are checked
 * before the call. A schema Zod cannot read falls back to "an object", and
 * the server still validates its own input.
 */
export function schemaFor(inputSchema: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(inputSchema as never)
  } catch {
    return z.record(z.string(), z.unknown())
  }
}

/** The JSON Schema the planner is shown: always an object. */
function parametersFor(inputSchema: Record<string, unknown>) {
  const { $schema: _unused, ...rest } = inputSchema
  return rest.type === 'object' ? rest : { type: 'object', properties: {} }
}

interface ServerRow {
  name: string
  url: string
  tokenCiphertext: string | null
  internal: boolean
  tools: McpToolInfo[]
  enabledTools: string[]
}

/** The switched-on tools of `rows`, as agent tools (FR2, FR3, FR4). */
export function toolsFromServers(rows: readonly ServerRow[]): AnyAgentTool[] {
  const tools: AnyAgentTool[] = []
  const seen = new Set<string>()
  for (const server of rows) {
    const enabled = new Set(server.enabledTools)
    if (enabled.size === 0) continue
    const token = server.tokenCiphertext
      ? decryptSecret(server.tokenCiphertext)
      : undefined
    if (token === null) {
      logger.warn('MCP token can no longer be read; its tools are skipped', {
        server: server.name,
      })
      continue
    }
    const endpoint = {
      name: server.name,
      url: server.url,
      token,
      internal: server.internal,
    }
    for (const info of server.tools) {
      if (!enabled.has(info.name)) continue
      const name = mcpToolName(server.name, info.name)
      // Two tools cut to the same name: the first keeps it.
      if (seen.has(name)) {
        logger.warn('MCP tool skipped: its name is taken', { tool: name })
        continue
      }
      seen.add(name)
      tools.push({
        name,
        description:
          `${info.description || info.name} (from the ${server.name} tool server)`.slice(
            0,
            1024,
          ),
        schema: schemaFor(info.inputSchema),
        parameters: parametersFor(info.inputSchema),
        run: (args, context) =>
          callMcpTool(
            endpoint,
            info.name,
            args,
            AbortSignal.any([context.signal, AbortSignal.timeout(MCP_CALL_MS)]),
          ),
      })
    }
  }
  return tools
}

/** Every switched-on MCP tool, read fresh so a change applies at once. */
export async function mcpTools(): Promise<AnyAgentTool[]> {
  try {
    const rows = await db
      .select({
        name: mcpServers.name,
        url: mcpServers.url,
        tokenCiphertext: mcpServers.tokenCiphertext,
        internal: mcpServers.internal,
        tools: mcpServers.tools,
        enabledTools: mcpServers.enabledTools,
      })
      .from(mcpServers)
    return toolsFromServers(rows)
  } catch (error) {
    // No MCP tools is a safe answer; a failed question is not.
    logger.warn('MCP tools could not be loaded', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
