import 'server-only'

import {
  type AiRole,
  ENV_CONNECTION_ID,
  aiSettings,
  connectionFor,
  modelFor,
} from '@/lib/ai-settings'
import { APP_NAME } from '@/lib/brand'
import { presetHeaders } from '@/lib/ai-settings/presets'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { annotateSpan } from '@/lib/observability/runs'
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
  return Boolean(aiSettings().NVIDIA_API_KEY)
}

/**
 * The key for a job's endpoint. The `.env` endpoint keeps its old rule — no
 * key, no RAG — while a saved connection may legitimately have none (a local
 * llama.cpp or Ollama server).
 */
function keyFor(role: AiRole): {
  url: string
  key: string | undefined
  headers: Record<string, string>
} {
  const connection = connectionFor(role)
  const url = connection.baseUrl.replace(/\/$/, '')
  const headers = presetHeaders(connection.preset, {
    url: env.APP_URL,
    name: APP_NAME,
  })
  if (connection.id === ENV_CONNECTION_ID) {
    return { url, key: requireKey(), headers }
  }
  if (connection.keyUnreadable) {
    throw new RagUpstreamError(
      401,
      `the API key saved for "${connection.name}" can no longer be read; enter it again in Settings`,
    )
  }
  return { url, key: connection.apiKey, headers }
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
  const key = aiSettings().NVIDIA_API_KEY
  if (!key) throw new RagNotConfiguredError()
  return key
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])

/**
 * NIM's 404 for a model it lists but does not serve to this account (#82).
 * Measured: persistent for such a model (four attempts, all 404), unlike the
 * empty-body 404 blip; a model name that does not exist gets a different
 * 404, "404 page not found".
 */
const NIM_UNSERVED_MODEL = /Function '[^']*': Not found for account/
const MAX_ATTEMPTS = 4

/**
 * Per-attempt deadline. **Not optional, and not cosmetic.**
 *
 * `fetch` has no timeout of its own, so before this a stalled upstream hung the
 * request indefinitely. Observed 2026-09-10: a single planner call took **86
 * seconds** where the same call normally takes 3-6, and the agentic loop's
 * `RAG_MAX_LOOP_MS` (15s) could do nothing about it — that budget is checked
 * BETWEEN iterations, so it cannot interrupt a call already in flight. The user
 * saw a 90-second spinner on a 15-second budget.
 *
 * A timeout turns that into a retry, which is what the retry loop was always
 * for. 60s is deliberately generous: a vision call over a page image genuinely
 * takes 40s (spec 0031), so anything tighter would abort real work.
 */
const REQUEST_TIMEOUT_MS = 60_000

/**
 * The caller's signal AND a deadline, whichever fires first.
 *
 * Composed rather than replaced: aborting because the browser navigated away
 * and aborting because the endpoint stalled are different events, and only the
 * second one should be retried.
 *
 * Built from an explicit `AbortController` rather than `AbortSignal.timeout`
 * for two reasons: the timer can be cleared the moment the response lands
 * instead of being left pending, and a plain `setTimeout` is something a test
 * can drive deterministically.
 */
function withDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`Request exceeded ${timeoutMs}ms`)),
    timeoutMs,
  )
  return {
    signal: signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal,
    clear: () => clearTimeout(timer),
  }
}

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
  {
    role,
    stream = false,
    signal,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxAttempts = MAX_ATTEMPTS,
  }: {
    /** Which job this is: it picks the connection (spec 0040 FR2). */
    role: AiRole
    stream?: boolean
    signal?: AbortSignal
    timeoutMs?: number
    maxAttempts?: number
  },
): Promise<Response> {
  const attempts = Math.min(MAX_ATTEMPTS, Math.max(1, Math.floor(maxAttempts)))
  const endpoint = keyFor(role)
  const key = endpoint.key
  const url = `${endpoint.url}${path}`

  let lastDetail = 'no response'
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response
    const deadline = withDeadline(signal, timeoutMs)
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...endpoint.headers,
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      })
    } catch (error) {
      // The CALLER aborting is final — the browser navigated away, and there is
      // nothing left to retry for. Only our own deadline is retryable.
      if (signal?.aborted) throw error

      lastDetail = `no response within ${timeoutMs}ms`
      if (attempt === attempts - 1) throw new RagUpstreamError(0, lastDetail)
      logger.warn('Inference request timed out', {
        timeoutMs,
        attempt: attempt + 1,
      })
      await sleep(backoffMs(attempt))
      continue
    } finally {
      deadline.clear()
    }

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

    // NIM's "Function '…': Not found for account" is not a blip (#82): it is
    // a model NIM lists for the account but does not serve to it. Retrying
    // only delays the same answer, so it fails at once, and says plainly
    // which model to change instead of passing on NIM's opaque function id.
    if (response.status === 404 && NIM_UNSERVED_MODEL.test(lastDetail)) {
      const model = (body as { model?: unknown }).model
      throw new RagUpstreamError(
        404,
        `the model "${String(model)}" is listed by the provider but not available to this account; choose another in Settings → Configuration → Models`,
      )
    }

    if (
      (!RETRYABLE.has(response.status) && !transientNotFound) ||
      attempt === attempts - 1
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
  /** Cuts the request off, e.g. at the agentic loop's time budget (#92). */
  signal?: AbortSignal,
  /**
   * A model other than the active generation's: only for building a new
   * generation (#56). Everything else must match the index it searches.
   */
  model: string = modelFor('embed'),
): Promise<number[][]> {
  if (input.length === 0) return []

  const response = await post(
    '/embeddings',
    { input, model, input_type: inputType },
    { role: 'embed', signal },
  )

  const json = (await response.json()) as EmbeddingsResponse
  annotateSpan({
    model,
    attributes: { inputs: input.length },
  })
  // The API is documented to preserve order, but sorting by `index` makes the
  // mapping back onto the input array explicit rather than assumed.
  return [...json.data]
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}

/**
 * One part of a multimodal message.
 *
 * Text-only calls keep passing a plain string for `content`; only the vision
 * paths (spec 0031 — layout parsing and `read_figure`) need parts. Modelled
 * rather than cast, because a wrong shape here fails as an opaque upstream 500
 * rather than a type error.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
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
      model: modelFor('chat'),
      messages,
      stream: true,
      temperature: 0.2,
      // Ask for a final usage frame so token counts are the provider's own
      // rather than inferred by counting stream deltas, which is not the same
      // thing as counting tokens.
      stream_options: { include_usage: true },
    },
    { role: 'chat', stream: true, signal },
  )

  if (!response.body) {
    throw new RagUpstreamError(response.status, 'upstream returned no body')
  }
  return response.body
}

/** The chat model in use, for display alongside an answer. */
export function chatModelName(): string {
  return modelFor('chat')
}

/** The planner model in use, for the trace. */
export function plannerModelName(): string {
  return modelFor('planner')
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
  /** Per-attempt deadline. Defaults to `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number
  /**
   * Attempts including the first, capped at the client's own maximum (4, the
   * default). A caller that fails open and has a user waiting — citation
   * verification — passes 1: a retry only adds another full deadline (#42).
   */
  maxAttempts?: number
  /**
   * The job, which picks the connection and the model (spec 0040 FR2).
   * Defaults to `chat`.
   */
  role?: AiRole
  /** Overrides the job's model on its connection. Rarely wanted. */
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
    model: options.model ?? modelFor(options.role ?? 'chat'),
    messages,
    stream: false,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 1500,
  }
  if (options.tools?.length) {
    body.tools = options.tools
    body.tool_choice = 'auto'
  }
  // Skip the planner's hidden reasoning when asked (#84). Planner-role calls
  // only: the field is a chat-template option some providers reject.
  if (
    (options.role ?? 'chat') === 'planner' &&
    aiSettings().RAG_PLANNER_REASONING === 'off'
  ) {
    body.chat_template_kwargs = { enable_thinking: false }
  }

  const response = await post('/chat/completions', body, {
    role: options.role ?? 'chat',
    signal: options.signal,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.maxAttempts !== undefined
      ? { maxAttempts: options.maxAttempts }
      : {}),
  })
  const json = (await response.json()) as CompletionResponse
  const tokens = json.usage?.total_tokens ?? 0
  // Credit the model and tokens to whichever run step made this call.
  annotateSpan({ model: String(body.model), tokens })

  return {
    choice: json.choices?.[0] ?? {},
    tokens,
  }
}
