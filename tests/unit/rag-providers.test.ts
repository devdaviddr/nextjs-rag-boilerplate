import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Provider adapters (spec 0045). Anthropic's payloads below follow the
 * Messages API's documented shapes (request, response with `tool_use`, and
 * the streamed event sequence), recorded as the API returns them.
 */

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}))
vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  createChatCompletion,
  createChatStream,
  createEmbeddings,
} from '@/lib/rag/client'
import {
  fromAnthropicResponse,
  fromAnthropicStream,
  toAnthropicRequest,
} from '@/lib/rag/providers/anthropic'
import { parseStreamFrame } from '@/lib/rag/sse'

const ANTHROPIC = 'https://api.anthropic.com/v1'
const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'search',
    description: 'Search the documents.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
}

function setEnv(over: Record<string, string | undefined>) {
  for (const k of Object.keys(mockEnv)) delete mockEnv[k]
  Object.assign(
    mockEnv,
    {
      RAG_CHAT_MODEL: 'test-chat',
      RAG_PLANNER_MODEL: 'test-planner',
      RAG_EMBED_MODEL: 'test-embed',
      LLM_API_KEY: 'sk-test',
    },
    over,
  )
}

let fetchMock: ReturnType<typeof vi.fn>
const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit]
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  }
}
const jsonResponse = (json: unknown) => ({
  ok: true,
  status: 200,
  json: async () => json,
  text: async () => JSON.stringify(json),
})

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

function sse(events: Array<[string, unknown]>): ReadableStream<Uint8Array> {
  const text = events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join('')
  const bytes = new TextEncoder().encode(text)
  // Split mid-event, as a network would.
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes.slice(0, 37))
      c.enqueue(bytes.slice(37, 200))
      c.enqueue(bytes.slice(200))
      c.close()
    },
  })
}

const STREAM: Array<[string, unknown]> = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        usage: { input_tokens: 812, output_tokens: 1 },
      },
    },
  ],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
  ],
  ['ping', { type: 'ping' }],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Staff get 25 ' },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'days [1].' },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 9 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
]

async function frames(stream: ReadableStream<Uint8Array>) {
  const text = await new Response(stream).text()
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => parseStreamFrame(block.replace(/^data: /, '')))
}

describe('Anthropic request translation (FR3)', () => {
  it('moves the system prompt out, merges turns and translates tools and images', () => {
    const body = toAnthropicRequest({
      model: 'claude-sonnet-5',
      messages: [
        { role: 'system', content: 'You answer from sources.' },
        { role: 'user', content: 'First part.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What does this chart show?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
            },
          ],
        },
      ],
      stream: false,
      temperature: 0.2,
      max_tokens: 800,
      tools: [SEARCH_TOOL],
      tool_choice: 'auto',
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(body).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 800,
      system: 'You answer from sources.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First part.' },
            { type: 'text', text: 'What does this chart show?' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgo=',
              },
            },
          ],
        },
      ],
      temperature: 0.2,
      tools: [
        {
          name: 'search',
          description: 'Search the documents.',
          input_schema: SEARCH_TOOL.function.parameters,
        },
      ],
      tool_choice: { type: 'auto' },
    })
  })
})

describe('Anthropic response translation (FR3)', () => {
  it('reads tool_use blocks back as tool calls, with usage', () => {
    const openai = fromAnthropicResponse({
      id: 'msg_02',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [
        { type: 'text', text: 'I will search for that.' },
        {
          type: 'tool_use',
          id: 'toolu_01A',
          name: 'search',
          input: { query: 'annual leave days' },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 600, output_tokens: 40 },
    })
    expect(openai).toEqual({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: 'I will search for that.',
            tool_calls: [
              {
                id: 'toolu_01A',
                type: 'function',
                function: {
                  name: 'search',
                  arguments: '{"query":"annual leave days"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 600, completion_tokens: 40, total_tokens: 640 },
    })
  })
})

describe('Anthropic stream translation (FR3)', () => {
  it('turns the event stream into the frames the answer path parses', async () => {
    const parsed = await frames(fromAnthropicStream(sse(STREAM)))
    const deltas = parsed.filter((f) => f.kind === 'delta')
    expect(
      deltas.map((f) => (f.kind === 'delta' ? f.content : '')).join(''),
    ).toBe('Staff get 25 days [1].')
    expect(
      deltas.some((f) => f.kind === 'delta' && f.finishReason === 'stop'),
    ).toBe(true)
    expect(deltas.at(-1)).toMatchObject({
      usage: { promptTokens: 812, completionTokens: 9 },
    })
  })

  it('passes an error event on as an error frame', async () => {
    const parsed = await frames(
      fromAnthropicStream(
        sse([
          [
            'error',
            {
              type: 'error',
              error: { type: 'overloaded_error', message: 'Overloaded' },
            },
          ],
        ]),
      ),
    )
    expect(parsed).toEqual([
      { kind: 'error', code: null, message: 'Overloaded' },
    ])
  })
})

describe('the client with an Anthropic endpoint (FR4)', () => {
  beforeEach(() => setEnv({ RAG_LLM_BASE_URL: ANTHROPIC }))

  it('sends the planner to /messages with Anthropic headers, and reads the tool call', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [
          { type: 'tool_use', id: 't1', name: 'search', input: { query: 'q' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    )
    const { choice, tokens } = await createChatCompletion(
      [{ role: 'user', content: 'Question?' }],
      { role: 'planner', tools: [SEARCH_TOOL] },
    )
    const call = lastCall()
    expect(call.url).toBe(`${ANTHROPIC}/messages`)
    expect(call.headers['x-api-key']).toBe('sk-test')
    expect(call.headers['anthropic-version']).toBe('2023-06-01')
    expect(call.headers.Authorization).toBeUndefined()
    expect(call.body.model).toBe('test-planner')
    expect(choice.message?.tool_calls?.[0]?.function).toEqual({
      name: 'search',
      arguments: '{"query":"q"}',
    })
    expect(tokens).toBe(15)
  })

  it('streams the chat answer as OpenAI frames', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: sse(STREAM) })
    const stream = await createChatStream([{ role: 'user', content: 'Q' }])
    expect(lastCall().body).toMatchObject({ stream: true, model: 'test-chat' })
    expect(lastCall().body.stream_options).toBeUndefined()
    const text = (await frames(stream))
      .map((f) => (f.kind === 'delta' ? f.content : ''))
      .join('')
    expect(text).toBe('Staff get 25 days [1].')
  })

  it('refuses embeddings, which Anthropic does not offer', async () => {
    await expect(createEmbeddings(['x'], 'query')).rejects.toThrow(
      /Anthropic has no embeddings API/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('input_type on embeddings (FR5)', () => {
  const embedding = jsonResponse({ data: [{ embedding: [0.1], index: 0 }] })

  it.each([
    ['NVIDIA NIM', 'https://integrate.api.nvidia.com/v1', true],
    ['a custom or self-hosted server', 'http://nim.internal:8000/v1', true],
    ['OpenAI', 'https://api.openai.com/v1', false],
    ['OpenRouter', 'https://openrouter.ai/api/v1', false],
  ])('%s: sent = %s', async (_name, url, sent) => {
    setEnv({ RAG_LLM_BASE_URL: url })
    fetchMock.mockResolvedValue(embedding)
    await createEmbeddings(['x'], 'passage')
    expect('input_type' in lastCall().body).toBe(sent)
  })
})
