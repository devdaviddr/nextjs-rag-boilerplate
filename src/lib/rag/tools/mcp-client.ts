import 'server-only'

import type { McpToolInfo } from '@/db/schema'
import { logger } from '@/lib/logger'
import { UnsafeUrlError, safeFetch } from '../fetch-url'

/**
 * A small Model Context Protocol client, Streamable HTTP transport only
 * (spec 0048): `initialize`, `tools/list` and `tools/call`, as JSON-RPC over
 * POST, reading either a JSON or an event-stream reply.
 *
 * Each operation opens its own session (initialize, then the request), so no
 * state is held between questions. A public server is reached through
 * `safeFetch` with spec 0047's address rules (NFR2); a server an admin marked
 * internal is fetched directly, and that is logged.
 */

export interface McpEndpoint {
  name: string
  url: string
  token?: string
  internal: boolean
}

export class McpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpError'
  }
}

export const MCP_PROTOCOL_VERSION = '2025-06-18'
/** Most of one reply read, in bytes. */
const MAX_REPLY_BYTES = 1_000_000
/** Tools read from one server, at most. */
const MAX_TOOLS = 200

interface Reply {
  status: number
  contentType: string
  sessionId?: string
  text: string
}

async function post(
  endpoint: McpEndpoint,
  message: Record<string, unknown>,
  session: { id?: string; initialised?: boolean },
  signal: AbortSignal,
): Promise<Reply> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
    ...(session.initialised
      ? { 'mcp-protocol-version': MCP_PROTOCOL_VERSION }
      : {}),
    ...(session.id ? { 'mcp-session-id': session.id } : {}),
  }
  const body = JSON.stringify(message)

  if (endpoint.internal) {
    logger.info('MCP request to an internal server', {
      category: 'agent',
      server: endpoint.name,
      method: message.method,
    })
    let response: Response
    try {
      response = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: 'error',
        cache: 'no-store',
      })
    } catch {
      throw new McpError(`${endpoint.name} did not answer.`)
    }
    const text = await response.text()
    if (text.length > MAX_REPLY_BYTES) {
      throw new McpError(`${endpoint.name} sent a reply that is too large.`)
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      sessionId: response.headers.get('mcp-session-id') ?? undefined,
      text,
    }
  }

  try {
    const res = await safeFetch(endpoint.url, {
      maxBytes: MAX_REPLY_BYTES,
      timeoutMs: 30_000,
      signal,
      anyStatus: true,
      request: { method: 'POST', headers, body },
    })
    return {
      status: res.status,
      contentType: res.contentType,
      sessionId: res.headers['mcp-session-id'],
      text: res.bytes.toString('utf8'),
    }
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new McpError(error.message)
    throw error
  }
}

/** The JSON-RPC reply to `id`, from a JSON body or an event stream. */
export function readRpcReply(
  reply: Pick<Reply, 'contentType' | 'text'>,
  id: number,
): unknown {
  const messages: unknown[] = []
  if (reply.contentType.includes('text/event-stream')) {
    for (const block of reply.text.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      try {
        messages.push(JSON.parse(data))
      } catch {
        // Not JSON: not a reply.
      }
    }
  } else {
    try {
      const parsed = JSON.parse(reply.text) as unknown
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]))
    } catch {
      throw new McpError('The server did not reply with JSON-RPC.')
    }
  }
  const match = messages.find(
    (m): m is { result?: unknown; error?: { message?: string } } =>
      Boolean(m) && typeof m === 'object' && (m as { id?: unknown }).id === id,
  )
  if (!match) throw new McpError('The server did not answer the request.')
  if (match.error) {
    throw new McpError(match.error.message || 'The server returned an error.')
  }
  return match.result
}

function explainStatus(endpoint: McpEndpoint, status: number): McpError {
  if (status === 401 || status === 403)
    return new McpError(`${endpoint.name} refused the token (HTTP ${status}).`)
  if (status === 404)
    return new McpError(`Nothing answers MCP at that URL (HTTP 404).`)
  return new McpError(`${endpoint.name} failed (HTTP ${status}).`)
}

/** Open a session and run `run` inside it. */
async function withSession<T>(
  endpoint: McpEndpoint,
  signal: AbortSignal,
  run: (
    request: (method: string, params?: unknown) => Promise<unknown>,
  ) => Promise<T>,
): Promise<T> {
  const session: { id?: string; initialised?: boolean } = {}
  let nextId = 1
  const request = async (method: string, params?: unknown) => {
    const id = nextId++
    const reply = await post(
      endpoint,
      { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
      session,
      signal,
    )
    if (reply.status < 200 || reply.status >= 300) {
      throw explainStatus(endpoint, reply.status)
    }
    if (reply.sessionId) session.id = reply.sessionId
    return readRpcReply(reply, id)
  }

  await request('initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'nextjs-rag-boilerplate', version: '1' },
  })
  session.initialised = true
  // A notification: no reply is expected beyond an accepting status.
  const note = await post(
    endpoint,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    session,
    signal,
  )
  if (note.status < 200 || note.status >= 300) {
    throw explainStatus(endpoint, note.status)
  }
  return run(request)
}

/** The tools a server lists (`tools/list`, every page). */
export async function listMcpTools(
  endpoint: McpEndpoint,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<McpToolInfo[]> {
  return withSession(endpoint, signal, async (request) => {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10 && tools.length < MAX_TOOLS; page++) {
      const result = (await request(
        'tools/list',
        cursor ? { cursor } : undefined,
      )) as {
        tools?: Array<{
          name?: unknown
          description?: unknown
          inputSchema?: unknown
        }>
        nextCursor?: unknown
      } | null
      for (const t of result?.tools ?? []) {
        if (typeof t.name !== 'string' || !t.name) continue
        tools.push({
          name: t.name.slice(0, 128),
          description:
            typeof t.description === 'string'
              ? t.description.slice(0, 1000)
              : '',
          inputSchema:
            t.inputSchema && typeof t.inputSchema === 'object'
              ? (t.inputSchema as Record<string, unknown>)
              : { type: 'object', properties: {} },
        })
      }
      cursor =
        typeof result?.nextCursor === 'string' ? result.nextCursor : undefined
      if (!cursor) break
    }
    return tools.slice(0, MAX_TOOLS)
  })
}

/**
 * Call one tool (`tools/call`). Its text content is the result; other
 * content is named, not included. A tool that reports an error returns that
 * as text, so the planner can see what went wrong.
 */
export async function callMcpTool(
  endpoint: McpEndpoint,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<string> {
  return withSession(endpoint, signal, async (request) => {
    const result = (await request('tools/call', {
      name,
      arguments: args ?? {},
    })) as {
      content?: Array<{ type?: string; text?: string }>
      structuredContent?: unknown
      isError?: boolean
    } | null
    const parts = (result?.content ?? []).map((c) =>
      c.type === 'text' && typeof c.text === 'string'
        ? c.text
        : `[${c.type ?? 'content'} not shown]`,
    )
    let text = parts.join('\n').trim()
    if (!text && result?.structuredContent !== undefined) {
      text = JSON.stringify(result.structuredContent)
    }
    if (result?.isError) return `The tool reported an error: ${text}`
    return text || '(The tool returned nothing.)'
  })
}
