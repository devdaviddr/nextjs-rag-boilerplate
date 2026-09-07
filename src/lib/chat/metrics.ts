/**
 * Generation metrics for an assistant message.
 *
 * Measured on the server around the upstream call, and derived from the
 * provider's own `usage` frame rather than by counting stream deltas — a delta
 * is not reliably one token, so counting them would produce a plausible-looking
 * number that is quietly wrong. `completionTokens` is null when the provider
 * omits usage, and the UI then shows what it does know rather than inventing
 * the rest.
 *
 * Pure, so the arithmetic (and its division-by-zero edges) is testable.
 */

export interface MessageMetrics {
  model: string
  promptTokens: number | null
  completionTokens: number | null
  /** Milliseconds from issuing the request to the first token arriving. */
  timeToFirstTokenMs: number | null
  /** Milliseconds for the whole request. */
  totalMs: number
  /**
   * Completion tokens per second across the generation window only —
   * first token to last, excluding the wait beforehand. That is the rate the
   * model actually produced text at; including TTFT would understate it.
   */
  tokensPerSecond: number | null
  /** How many chunks were fed to the model. */
  sourceCount: number
  /** 'search' (similarity) or 'document' (whole-document request). */
  retrieval: 'search' | 'document' | 'agentic'
}

export interface MetricsInput {
  model: string
  promptTokens?: number | null
  completionTokens?: number | null
  startedAt: number
  firstTokenAt: number | null
  finishedAt: number
  sourceCount: number
  retrieval: 'search' | 'document' | 'agentic'
}

export function computeMetrics(input: MetricsInput): MessageMetrics {
  const {
    model,
    promptTokens = null,
    completionTokens = null,
    startedAt,
    firstTokenAt,
    finishedAt,
    sourceCount,
    retrieval,
  } = input

  const timeToFirstTokenMs =
    firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt)
  const totalMs = Math.max(0, finishedAt - startedAt)

  // Guard the generation window: a single-chunk answer can arrive in the same
  // millisecond it started, and dividing by zero would report Infinity.
  const generationMs =
    firstTokenAt === null ? 0 : Math.max(0, finishedAt - firstTokenAt)
  const tokensPerSecond =
    completionTokens !== null && completionTokens > 0 && generationMs > 0
      ? Number((completionTokens / (generationMs / 1000)).toFixed(1))
      : null

  return {
    model,
    promptTokens,
    completionTokens,
    timeToFirstTokenMs,
    totalMs,
    tokensPerSecond,
    sourceCount,
    retrieval,
  }
}

/** Short model label: `nvidia/nemotron-3-super-120b-a12b` → `nemotron-3-super-120b-a12b`. */
export function shortModelName(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}

function formatSeconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * The parts to show beneath an answer, already formatted. Anything the
 * provider did not report is simply omitted rather than shown as zero.
 */
export function formatMetrics(metrics: MessageMetrics): string[] {
  const parts: string[] = []
  if (metrics.completionTokens !== null) {
    parts.push(`${metrics.completionTokens} tokens`)
  }
  if (metrics.tokensPerSecond !== null) {
    parts.push(`${metrics.tokensPerSecond} tok/s`)
  }
  if (metrics.timeToFirstTokenMs !== null) {
    parts.push(`${formatSeconds(metrics.timeToFirstTokenMs)} to first token`)
  }
  parts.push(`${formatSeconds(metrics.totalMs)} total`)
  parts.push(
    `${metrics.sourceCount} ${metrics.sourceCount === 1 ? 'source' : 'sources'}`,
  )
  parts.push(
    metrics.retrieval === 'document'
      ? 'whole document'
      : metrics.retrieval === 'agentic'
        ? 'agentic search'
        : 'similarity search',
  )
  parts.push(shortModelName(metrics.model))
  return parts
}
