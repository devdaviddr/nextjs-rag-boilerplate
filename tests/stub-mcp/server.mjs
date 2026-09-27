import { createServer } from 'node:http'

/**
 * A minimal MCP server over Streamable HTTP, for tests (spec 0048): it
 * answers `initialize`, `tools/list` (two pages) and `tools/call`, holds a
 * session id, checks a bearer token when given one, and replies as JSON or
 * as an event stream.
 *
 *   const stub = await startStubMcp({ token: 't', sse: true })
 *   stub.url   // http://127.0.0.1:<port>/mcp
 *   await stub.close()
 */

const TOOLS = [
  {
    name: 'lookup_policy',
    description: 'Look up a company policy by topic.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', minLength: 1 } },
      required: ['topic'],
    },
  },
  {
    name: 'add_numbers',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
]

/** @param {{ token?: string, sse?: boolean, port?: number }} [options] */
export async function startStubMcp({ token, sse = false, port = 0 } = {}) {
  const requests = []
  const SESSION = 'stub-session-1'

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const headers = req.headers
      let message
      try {
        message = JSON.parse(raw)
      } catch {
        res.writeHead(400).end()
        return
      }
      requests.push({ headers, message })
      if (req.method !== 'POST') return res.writeHead(405).end()
      if (token && headers.authorization !== `Bearer ${token}`) {
        return res.writeHead(401).end()
      }
      if (
        message.method !== 'initialize' &&
        headers['mcp-session-id'] !== SESSION
      ) {
        return res.writeHead(400).end('missing session')
      }
      if (message.id === undefined) return res.writeHead(202).end()

      const reply = (result) => {
        const body = { jsonrpc: '2.0', id: message.id, ...result }
        const extra =
          message.method === 'initialize' ? { 'mcp-session-id': SESSION } : {}
        if (sse) {
          res.writeHead(200, { 'content-type': 'text/event-stream', ...extra })
          res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`)
        } else {
          res.writeHead(200, { 'content-type': 'application/json', ...extra })
          res.end(JSON.stringify(body))
        }
      }

      switch (message.method) {
        case 'initialize':
          return reply({
            result: {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'stub-mcp', version: '1' },
            },
          })
        case 'tools/list':
          return reply({
            result: message.params?.cursor
              ? { tools: [TOOLS[1]] }
              : { tools: [TOOLS[0]], nextCursor: 'page-2' },
          })
        case 'tools/call': {
          const { name, arguments: args = {} } = message.params ?? {}
          if (name === 'lookup_policy') {
            return reply({
              result: {
                content: [
                  {
                    type: 'text',
                    text: `Policy on ${args.topic}: staff get 25 days.`,
                  },
                ],
              },
            })
          }
          if (name === 'add_numbers') {
            return reply({
              result: {
                content: [{ type: 'text', text: String(args.a + args.b) }],
              },
            })
          }
          return reply({
            result: {
              content: [{ type: 'text', text: `Unknown tool ${name}` }],
              isError: true,
            },
          })
        }
        default:
          return reply({ error: { code: -32601, message: 'Method not found' } })
      }
    })
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const { port: bound } = server.address()
  return {
    url: `http://127.0.0.1:${bound}/mcp`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
