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
    if (!RETRYABLE.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
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
    },
    { stream: true, signal },
  )

  if (!response.body) {
    throw new RagUpstreamError(response.status, 'upstream returned no body')
  }
  return response.body
}
