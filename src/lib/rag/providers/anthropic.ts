import type {
  OpenAiChatBody,
  OpenAiChatResponse,
  ProviderAdapter,
} from './types'

/**
 * Anthropic's Messages API (spec 0045 FR3), translated to and from the
 * OpenAI format the app speaks.
 *
 * The differences that matter: the system prompt is a top-level `system`, not
 * a message; `max_tokens` is required; tools are `{name, description,
 * input_schema}` and come back as `tool_use` content blocks; images are
 * `image` blocks with a base64 or URL source; the stream is typed events
 * (`content_block_delta`, `message_delta`) rather than chat-completion
 * chunks. Anthropic has no embeddings API.
 */

export const ANTHROPIC_VERSION = '2023-06-01'

type OpenAiContent = OpenAiChatBody['messages'][number]['content']

type AnthropicBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; url: string }
    }

function toBlocks(content: OpenAiContent): AnthropicBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.map((part): AnthropicBlock => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const url = part.image_url.url
    const data = /^data:([^;,]+);base64,(.*)$/s.exec(url)
    return data
      ? {
          type: 'image',
          source: { type: 'base64', media_type: data[1]!, data: data[2]! },
        }
      : { type: 'image', source: { type: 'url', url } }
  })
}

const textOf = (content: OpenAiContent) =>
  typeof content === 'string'
    ? content
    : content
        .map((p) => (p.type === 'text' ? p.text : ''))
        .filter(Boolean)
        .join('\n')

/** OpenAI tool definitions (`{type: 'function', function}`) as Anthropic's. */
function toTools(tools: unknown[]) {
  return tools.map((tool) => {
    const fn = (tool as { function?: Record<string, unknown> }).function ?? {}
    return {
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    }
  })
}

export function toAnthropicRequest(body: OpenAiChatBody) {
  const system = body.messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .join('\n\n')
  // Consecutive turns from the same side become one turn of several blocks.
  const messages: Array<{
    role: 'user' | 'assistant'
    content: AnthropicBlock[]
  }> = []
  for (const m of body.messages) {
    if (m.role === 'system') continue
    const last = messages[messages.length - 1]
    if (last && last.role === m.role) last.content.push(...toBlocks(m.content))
    else messages.push({ role: m.role, content: toBlocks(m.content) })
  }
  return {
    model: body.model,
    // Required by Anthropic; the client always sets one for completions.
    max_tokens: body.max_tokens ?? 4096,
    ...(system ? { system } : {}),
    messages,
    ...(body.temperature !== undefined
      ? { temperature: Math.min(1, body.temperature) }
      : {}),
    ...(body.tools?.length
      ? { tools: toTools(body.tools), tool_choice: { type: 'auto' } }
      : {}),
    ...(body.stream ? { stream: true } : {}),
  }
}

const FINISH: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
}

interface AnthropicResponse {
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: string }
  >
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export function fromAnthropicResponse(json: unknown): OpenAiChatResponse {
  const r = (json ?? {}) as AnthropicResponse
  const blocks = r.content ?? []
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const toolCalls = blocks
    .filter(
      (
        b,
      ): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
        b.type === 'tool_use',
    )
    .map((b) => ({
      id: b.id,
      type: 'function' as const,
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }))
  const prompt = r.usage?.input_tokens ?? 0
  const completion = r.usage?.output_tokens ?? 0
  return {
    choices: [
      {
        finish_reason: FINISH[r.stop_reason ?? ''] ?? r.stop_reason,
        message: {
          content: text || null,
          tool_calls: toolCalls.length ? toolCalls : null,
        },
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  }
}

/**
 * Anthropic's stream events as OpenAI chat-completion chunks: text deltas as
 * `delta.content`, the stop reason as `finish_reason`, the token counts as a
 * final usage frame, then `[DONE]`. Other events (pings, block starts and
 * stops, thinking) carry nothing the answer path reads.
 */
export function fromAnthropicStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let prompt = 0
  let completion = 0
  const frame = (payload: unknown) =>
    encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)

  const translate = (
    data: string,
    out: TransformStreamDefaultController<Uint8Array>,
  ) => {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    switch (event.type) {
      case 'message_start': {
        const usage = (event.message as { usage?: Record<string, number> })
          ?.usage
        prompt = usage?.input_tokens ?? 0
        completion = usage?.output_tokens ?? 0
        return
      }
      case 'content_block_delta': {
        const delta = event.delta as { type?: string; text?: string }
        if (delta?.type === 'text_delta' && delta.text) {
          out.enqueue(frame({ choices: [{ delta: { content: delta.text } }] }))
        }
        return
      }
      case 'message_delta': {
        const usage = event.usage as { output_tokens?: number } | undefined
        if (usage?.output_tokens !== undefined) completion = usage.output_tokens
        const stop = (event.delta as { stop_reason?: string })?.stop_reason
        if (stop) {
          out.enqueue(
            frame({
              choices: [{ delta: {}, finish_reason: FINISH[stop] ?? stop }],
            }),
          )
        }
        return
      }
      case 'message_stop':
        out.enqueue(
          frame({
            choices: [],
            usage: {
              prompt_tokens: prompt,
              completion_tokens: completion,
              total_tokens: prompt + completion,
            },
          }),
        )
        out.enqueue(encoder.encode('data: [DONE]\n\n'))
        return
      case 'error': {
        const error = event.error as { type?: string; message?: string }
        out.enqueue(
          frame({
            error: { message: error?.message ?? error?.type ?? 'error' },
          }),
        )
        return
      }
    }
  }

  const drain = (out: TransformStreamDefaultController<Uint8Array>) => {
    let end: number
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) translate(data, out)
    }
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
        drain(out)
      },
      flush(out) {
        buffer += decoder.decode()
        if (buffer.trim()) {
          buffer += '\n\n'
          drain(out)
        }
      },
    }),
  )
}

export const anthropicAdapter: ProviderAdapter = {
  authHeaders: (key): Record<string, string> => ({
    ...(key ? { 'x-api-key': key } : {}),
    'anthropic-version': ANTHROPIC_VERSION,
  }),
  chatRequest: (body) => ({
    path: '/messages',
    body: toAnthropicRequest(body),
  }),
  chatResponse: fromAnthropicResponse,
  chatStream: fromAnthropicStream,
  embeddings: false,
}
