import 'server-only'

import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import type { EmbeddingInputType } from './constants'

/**
 * Client for an OpenAI-compatible inference endpoint — NVIDIA NIM by default,
 * but `RAG_LLM_BASE_URL` accepts any compatible server, so pointing it at a
 * local Ollama or llama.cpp gives a fully offline deployment (spec 0025).
 *
 * `server-only` so the API key can never be bundled into client JS.
 */

/** True when a key is configured. The RAG features report themselves as
 * unavailable rather than throwing at boot, so builds and CI work without
 * secrets — same posture as OAuth/email/push in this boilerplate. */
export function isRagConfigured(): boolean {
  return Boolean(env.NVIDIA_API_KEY)
}

export class RagNotConfiguredError extends Error {
  constructor() {
    super(
      'Document chat is not configured. Set NVIDIA_API_KEY to enable it — a free key is available at build.nvidia.com.',
    )
    this.name = 'RagNotConfiguredError'
  }
}

export class RagUpstreamError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(`Inference request failed (HTTP ${status}): ${detail}`)
    this.name = 'RagUpstreamError'
    this.status = status
  }
}

function requireKey(): string {
  const key = env.NVIDIA_API_KEY
  if (!key) throw new RagNotConfiguredError()
  return key
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 4

function backoffMs(attempt: number): number {
  // 0.5s, 1s, 2s — plus jitter so a batch of parallel workers doesn't retry
  // in lockstep and re-trigger the same rate limit.
  return 2 ** attempt * 500 + Math.random() * 250
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * POST to the endpoint with bounded retries on rate limits and transient
 * upstream failures. Free NIM tiers are rate-limited rather than token-billed,
 * so a 429 means "wait", not "stop".
 */
async function post(
  path: string,
  body: unknown,
  { stream = false, signal }: { stream?: boolean; signal?: AbortSignal } = {},
): Promise<Response> {
  const key = requireKey()
  const url = `${env.RAG_LLM_BASE_URL.replace(/\/$/, '')}${path}`

  let lastDetail = 'no response'
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (response.ok) return response

    lastDetail = (await response.text()).slice(0, 300)

    // A 404 with an EMPTY body is an infrastructure blip, not "no such model".
    //
    // Observed live: a chat completion failed with `HTTP 404` and no body,
    // killing the answer outright because 404 is not retryable. The identical
    // request — same URL, same model, same payload — returned 200 with a full
    // answer moments later. A real not-found comes back with a JSON error body
    // explaining itself; this did not. Narrow on purpose: a genuine 404 (a
    // misconfigured RAG_CHAT_MODEL) still fails immediately rather than
    // retrying four times and hiding a config error behind a slow failure.
    const transientNotFound = response.status === 404 && lastDetail.length === 0

    if (
      (!RETRYABLE.has(response.status) && !transientNotFound) ||
      attempt === MAX_ATTEMPTS - 1
    ) {
      throw new RagUpstreamError(response.status, lastDetail)
    }

    logger.warn('Inference request retrying', {
      status: response.status,
      attempt: attempt + 1,
    })
    await sleep(backoffMs(attempt))
  }

  throw new RagUpstreamError(0, lastDetail)
}

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>
}

/**
 * Embed a batch of strings. `inputType` is required, never defaulted — the
 * model is asymmetric and picking the wrong one degrades retrieval silently
 * (see constants.ts).
 */
export async function createEmbeddings(
  input: string[],
  inputType: EmbeddingInputType,
): Promise<number[][]> {
  if (input.length === 0) return []

  const response = await post('/embeddings', {
    input,
    model: env.RAG_EMBED_MODEL,
    input_type: inputType,
  })

  const json = (await response.json()) as EmbeddingsResponse
  // The API is documented to preserve order, but sorting by `index` makes the
  // mapping back onto the input array explicit rather than assumed.
  return [...json.data]
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Open a streaming chat completion. Returns the raw SSE body.
 *
 * `signal` should be the incoming request's signal: when the browser navigates
 * away mid-answer, the upstream generation is cancelled too rather than being
 * left to run — and to stop the aborted socket surfacing as an unhandled
 * ECONNRESET.
 */
export async function createChatStream(
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await post(
    '/chat/completions',
    {
      model: env.RAG_CHAT_MODEL,
      messages,
      stream: true,
      temperature: 0.2,
      // Ask for a final usage frame so token counts are the provider's own
      // rather than inferred by counting stream deltas, which is not the same
      // thing as counting tokens.
      stream_options: { include_usage: true },
    },
    { stream: true, signal },
  )

  if (!response.body) {
    throw new RagUpstreamError(response.status, 'upstream returned no body')
  }
  return response.body
}

/** The chat model in use, for display alongside an answer. */
export function chatModelName(): string {
  return env.RAG_CHAT_MODEL
}

/** The planner model in use, for the trace. */
export function plannerModelName(): string {
  return env.RAG_PLANNER_MODEL
}

export interface CompletionChoice {
  finish_reason?: string
  message?: {
    content?: string | null
    tool_calls?: Array<{
      function?: { name?: string; arguments?: string }
    }> | null
  }
}

interface CompletionResponse {
  choices?: CompletionChoice[]
  usage?: { total_tokens?: number }
}

export interface CompletionOptions {
  /** Defaults to the chat model; the planner passes `RAG_PLANNER_MODEL`. */
  model?: string
  /** Advertise tools. With these present, reasoning models split their
   *  chain-of-thought into `reasoning_content` and leave `content` clean —
   *  which is why native tool calling tolerates a small token budget and the
   *  JSON fallback does not. */
  tools?: unknown[]
  /** At least ~1500 when relying on a JSON reply with no `tools` present: the
   *  reasoning preamble streams into `content` and a small budget truncates it
   *  before any JSON appears. That truncation, not a broken model, is what
   *  earlier probes misread as malformed output. */
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

/**
 * One non-streaming chat completion.
 *
 * Used for the planner, the query rewriter and citation verification — all of
 * which need a whole answer to parse rather than tokens to forward. Streaming
 * answers still go through `createChatStream`.
 */
export async function createChatCompletion(
  messages: ChatMessage[],
  options: CompletionOptions = {},
): Promise<{ choice: CompletionChoice; tokens: number }> {
  const body: Record<string, unknown> = {
    model: options.model ?? env.RAG_CHAT_MODEL,
    messages,
    stream: false,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 1500,
  }
  if (options.tools?.length) {
    body.tools = options.tools
    body.tool_choice = 'auto'
  }

  const response = await post('/chat/completions', body, {
    signal: options.signal,
  })
  const json = (await response.json()) as CompletionResponse

  return {
    choice: json.choices?.[0] ?? {},
    tokens: json.usage?.total_tokens ?? 0,
  }
}
