/**
 * One `data:` frame of an OpenAI-compatible chat-completion stream, classified.
 *
 * Pulled out of the chat route so the classification is testable on its own.
 * The case that motivated it (#43): the upstream can answer a streaming request
 * with HTTP 200 and then send an ERROR as a frame —
 *
 *   data: {"error":{"message":"Service temporarily overloaded",
 *          "type":"service_unavailable","code":503}}
 *
 * That is valid JSON with no `choices`, so the route used to read it as an
 * empty frame, finish with no text, and tell the user "the model returned an
 * empty answer". It is an upstream failure and is now reported as one.
 */
export type StreamFrame =
  | {
      kind: 'delta'
      content: string
      reasoningChars: number
      finishReason: string | null
      usage: {
        promptTokens: number | null
        completionTokens: number | null
      } | null
    }
  | { kind: 'error'; code: number | null; message: string }
  | { kind: 'skip' }

interface RawFrame {
  error?: { message?: unknown; code?: unknown; type?: unknown } | string
  choices?: Array<{
    finish_reason?: string | null
    delta?: { content?: string; reasoning_content?: string }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** Classify the payload after `data:`. Never throws. */
export function parseStreamFrame(data: string): StreamFrame {
  const payload = data.trim()
  if (!payload || payload === '[DONE]') return { kind: 'skip' }

  let parsed: RawFrame
  try {
    parsed = JSON.parse(payload) as RawFrame
  } catch {
    // A malformed frame is skipped rather than aborting the answer; nemotron
    // models are known to emit occasional bad JSON.
    return { kind: 'skip' }
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'skip' }

  if (parsed.error) {
    const error = parsed.error
    if (typeof error === 'string')
      return { kind: 'error', code: null, message: error }
    const code = Number(error.code)
    return {
      kind: 'error',
      code: Number.isFinite(code) ? code : null,
      message:
        typeof error.message === 'string' && error.message
          ? error.message
          : typeof error.type === 'string'
            ? error.type
            : 'upstream error',
    }
  }

  const choice = parsed.choices?.[0]
  return {
    kind: 'delta',
    content: choice?.delta?.content ?? '',
    reasoningChars: choice?.delta?.reasoning_content?.length ?? 0,
    finishReason: choice?.finish_reason ?? null,
    usage: parsed.usage
      ? {
          promptTokens: parsed.usage.prompt_tokens ?? null,
          completionTokens: parsed.usage.completion_tokens ?? null,
        }
      : null,
  }
}

/**
 * How long to wait before the one drafting retry. An upstream that just said
 * it is overloaded is not going to recover in the 230ms the old immediate
 * retry allowed (#43); an empty stream is a shorter blip.
 */
export function draftRetryDelayMs(upstreamError: boolean): number {
  return upstreamError ? 2_000 : 1_000
}

/** What the user is told when drafting fails after the retry. */
export function draftFailureMessage(
  upstreamError: { code: number | null; message: string } | null,
): string {
  if (!upstreamError) {
    return 'The model returned an empty answer. Please try again — this is usually transient.'
  }
  const overloaded =
    upstreamError.code === 503 ||
    upstreamError.code === 429 ||
    /overload|capacity|rate limit|unavailable/i.test(upstreamError.message)
  const code = upstreamError.code ? ` (upstream ${upstreamError.code})` : ''
  return overloaded
    ? `The model is overloaded right now${code}. Please try again in a minute.`
    : `The model failed to answer${code}. Please try again.`
}
