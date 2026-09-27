import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * MCP tools (spec 0048): the Streamable HTTP client against a stub server,
 * and switched-on tools turned into agent tools.
 */

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/env', () => ({ env: { AUTH_SECRET: 'auth-secret-for-tests' } }))
vi.mock('@/db', () => ({ db: {} }))

import { startStubMcp } from '../stub-mcp/server.mjs'
import { encryptSecret } from '@/lib/ai-settings/crypto'
import { runRegisteredTool, toolRegistry } from '@/lib/rag/tools'
import {
  MCP_PROTOCOL_VERSION,
  McpError,
  callMcpTool,
  listMcpTools,
  readRpcReply,
} from '@/lib/rag/tools/mcp-client'
import { mcpToolName, toolsFromServers } from '@/lib/rag/tools/mcp'

type Stub = {
  url: string
  requests: Array<{
    headers: Record<string, string>
    message: { method?: string }
  }>
  close: () => Promise<void>
}

let json: Stub
let sse: Stub
beforeAll(async () => {
  json = await startStubMcp({ token: 'secret-token' })
  sse = await startStubMcp({ sse: true })
})
afterAll(async () => {
  await json.close()
  await sse.close()
})

const context = {
  userId: 'u1',
  permittedKbIds: [],
  signal: AbortSignal.timeout(5000),
}

describe('the MCP client (FR1, FR4)', () => {
  it('initialises, keeps the session, and lists every page of tools', async () => {
    const tools = await listMcpTools({
      name: 'Stub',
      url: json.url,
      token: 'secret-token',
      internal: true,
    })
    expect(tools.map((t) => t.name)).toEqual(['lookup_policy', 'add_numbers'])
    const methods = json.requests.map((r) => r.message.method)
    expect(methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
    ])
    const last = json.requests.at(-1)!.headers
    expect(last['mcp-session-id']).toBe('stub-session-1')
    expect(last['mcp-protocol-version']).toBe(MCP_PROTOCOL_VERSION)
    expect(last.authorization).toBe('Bearer secret-token')
  })

  it('reads event-stream replies and returns the text content', async () => {
    const text = await callMcpTool(
      { name: 'Stub', url: sse.url, internal: true },
      'lookup_policy',
      { topic: 'leave' },
      AbortSignal.timeout(5000),
    )
    expect(text).toBe('Policy on leave: staff get 25 days.')
  })

  it('returns a tool error as text, and a refused token as an error', async () => {
    expect(
      await callMcpTool(
        { name: 'Stub', url: sse.url, internal: true },
        'nope',
        {},
        AbortSignal.timeout(5000),
      ),
    ).toBe('The tool reported an error: Unknown tool nope')
    await expect(
      listMcpTools({
        name: 'Stub',
        url: json.url,
        token: 'wrong',
        internal: true,
      }),
    ).rejects.toThrow('Stub refused the token (HTTP 401).')
  })

  it('NFR2: a server not marked internal gets the public-address rules', async () => {
    await expect(
      listMcpTools({ name: 'Stub', url: json.url, internal: false }),
    ).rejects.toThrow(McpError)
    await expect(
      listMcpTools({
        name: 'Stub',
        url: 'http://169.254.169.254/mcp',
        internal: false,
      }),
    ).rejects.toThrow('169.254.169.254 is not a public address.')
  })

  it('reads a JSON-RPC error as an error', () => {
    expect(() =>
      readRpcReply(
        {
          contentType: 'application/json',
          text: '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}',
        },
        2,
      ),
    ).toThrow('Method not found')
  })
})

describe('switched-on tools become agent tools (FR2–FR5)', () => {
  const server = (over: Record<string, unknown> = {}) => ({
    name: 'Policy Desk',
    url: '',
    tokenCiphertext: null,
    internal: true,
    tools: [
      {
        name: 'lookup_policy',
        description: 'Look up a company policy by topic.',
        inputSchema: {
          type: 'object',
          properties: { topic: { type: 'string', minLength: 1 } },
          required: ['topic'],
        },
      },
      { name: 'add_numbers', description: 'Add.', inputSchema: {} },
    ],
    enabledTools: ['lookup_policy'],
    ...over,
  })

  it('offers only the switched-on tools, named mcp_<server>_<tool>', () => {
    const tools = toolsFromServers([server({ url: sse.url })])
    expect(tools.map((t) => t.name)).toEqual(['mcp_policy_desk_lookup_policy'])
    expect(tools[0]!.parameters).toMatchObject({ required: ['topic'] })
    expect(toolsFromServers([server({ enabledTools: [] })])).toEqual([])
    expect(
      mcpToolName('A very long server name indeed', 'x'.repeat(80)),
    ).toHaveLength(64)
  })

  it('validates arguments against the server schema, then calls it', async () => {
    const registry = toolRegistry(toolsFromServers([server({ url: sse.url })]))
    const name = 'mcp_policy_desk_lookup_policy'
    expect(
      await runRegisteredTool(registry, name, '{}', context),
    ).toMatchObject({
      text: expect.stringContaining('Invalid arguments'),
    })
    expect(
      await runRegisteredTool(registry, name, '{"topic":"leave"}', context),
    ).toEqual({ text: 'Policy on leave: staff get 25 days.', tokens: 0 })
  })

  it('sends the saved token, decrypted', async () => {
    const registry = toolRegistry(
      toolsFromServers([
        server({
          url: json.url,
          tokenCiphertext: encryptSecret('secret-token'),
        }),
      ]),
    )
    expect(
      await runRegisteredTool(
        registry,
        'mcp_policy_desk_lookup_policy',
        '{"topic":"travel"}',
        context,
      ),
    ).toMatchObject({ text: 'Policy on travel: staff get 25 days.' })
  })

  it('FR5: a server that is down makes a failed step, not a thrown error', async () => {
    const registry = toolRegistry(
      toolsFromServers([server({ url: 'http://127.0.0.1:9/mcp' })]),
    )
    expect(
      await runRegisteredTool(
        registry,
        'mcp_policy_desk_lookup_policy',
        '{"topic":"leave"}',
        context,
      ),
    ).toBeNull()
  })
})
