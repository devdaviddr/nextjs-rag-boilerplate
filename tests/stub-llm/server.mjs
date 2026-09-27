#!/usr/bin/env node
// A stand-in for an OpenAI-compatible model server, for tests that must reach
// a cited answer without a real key (#152). Deterministic, offline, no deps.
//
//   node tests/stub-llm/server.mjs [port]      # default 4010
//   LLM_API_KEY=stub RAG_LLM_BASE_URL=http://127.0.0.1:4010/v1 pnpm start
//
// - /v1/embeddings: a bag of content words hashed into 2048 dimensions and
//   normalised, so a question and a passage that share words score high and
//   ones that share none score zero. Enough for retrieval to find the right
//   page and for the relevance floor to refuse an unrelated question.
// - /v1/chat/completions, three shapes the app sends:
//   - with `tools` (the agentic planner): search for the question once, then
//     say it has enough;
//   - streamed (the answer writer): an answer citing source [1];
//   - otherwise (the citation verifier): nothing unsupported.
// It answers from the request only; it knows nothing about any document.
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? process.env.STUB_LLM_PORT ?? 4010)
const DIMENSIONS = 2048

const STOPWORDS = new Set(
  (
    'a an the of to in on at for from by with and or but is are was were be been ' +
    'do does did i you we they it this that these those what which who whom how ' +
    'many much get got can could should would will may my your our their me us ' +
    'as if into about than then there here so not no yes'
  ).split(' '),
)

/** FNV-1a, so the same word always lands in the same dimension. */
function hash(word) {
  let h = 0x811c9dc5
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function embed(text) {
  const vector = new Array(DIMENSIONS).fill(0)
  for (const word of String(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? []) {
    if (STOPWORDS.has(word) || word.length < 2) continue
    // Singular and plural in one bucket: "days" and "day" should match.
    vector[hash(word.replace(/s$/, '')) % DIMENSIONS] += 1
  }
  const norm = Math.hypot(...vector) || 1
  return vector.map((v) => v / norm)
}

/** The question the planner is asked about, from its prompt. */
function plannerQuestion(messages) {
  const user = [...messages].reverse().find((m) => m.role === 'user')
  const text = typeof user?.content === 'string' ? user.content : ''
  return text.match(/Question: (.*)/)?.[1]?.trim() ?? text.trim()
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function completion(message) {
  return {
    id: 'stub',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message,
        finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }
}

function stream(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const piece of text.match(/.{1,24}/g) ?? []) {
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`,
    )
  }
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\n`,
  )
  res.end('data: [DONE]\n\n')
}

function chat(body, res) {
  const messages = body.messages ?? []
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const prompt = JSON.stringify(messages)
    // One search, then enough: the planner's second call sees "Searches so far".
    if (prompt.includes('Searches so far')) {
      return json(
        res,
        200,
        completion({ role: 'assistant', content: 'I have enough to answer.' }),
      )
    }
    return json(
      res,
      200,
      completion({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_stub_1',
            type: 'function',
            function: {
              name: 'search_documents',
              arguments: JSON.stringify({ query: plannerQuestion(messages) }),
            },
          },
        ],
      }),
    )
  }
  if (body.stream) {
    return stream(
      res,
      'According to your documents, this is covered in the cited passage [1].',
    )
  }
  return json(
    res,
    200,
    completion({ role: 'assistant', content: '{"unsupported": []}' }),
  )
}

createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    const path = new URL(req.url, 'http://stub').pathname
    if (req.method === 'GET' && path.endsWith('/models')) {
      return json(res, 200, {
        object: 'list',
        data: [{ id: 'stub', object: 'model' }],
      })
    }
    let body
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return json(res, 400, { error: { message: 'invalid JSON' } })
    }
    if (req.method === 'POST' && path.endsWith('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      return json(res, 200, {
        object: 'list',
        data: inputs.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: embed(text),
        })),
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      })
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions'))
      return chat(body, res)
    json(res, 404, { error: { message: `stub has no ${req.method} ${path}` } })
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`stub LLM on http://127.0.0.1:${PORT}/v1`)
})
