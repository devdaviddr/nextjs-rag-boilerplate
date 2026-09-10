/**
 * The planner: the model's control over retrieval (spec 0029 FR3).
 *
 * ## One decision type, two adapters
 *
 * The orchestrator only ever sees a `PlannerDecision`. How that decision was
 * obtained — a native tool call, or a JSON object parsed out of `content` — is
 * an implementation detail behind `parseToolCallDecision` /
 * `parseJsonDecision`. Keeping the shape stable is what let the loop be
 * designed before the model probe had settled which mechanism to use.
 *
 * Measured (40 native tool-call attempts across four reachable models): native
 * tool calling is the more reliable mechanism AND the more token-budget-robust
 * one. These are reasoning models — with no `tools` array present the
 * chain-of-thought streams into `content`, so a small `max_tokens` truncates
 * mid-thought before any JSON appears. With `tools` present, reasoning is split
 * into `reasoning_content` and `content` stays clean. Every earlier
 * "malformed JSON" observation was that truncation, not a broken model.
 *
 * So native tool calling is the default. The JSON adapter is retained because
 * it costs one small function and removes a single point of failure, not
 * because it is safer.
 */

export type PlannerAction = 'search' | 'answer' | 'refuse' | 'read-figure'

export interface PlannerDecision {
  action: PlannerAction
  /** Present when `action === 'search'`. */
  query?: string
  /**
   * An optional narrowing hint. The model may name a document it believes is
   * relevant. It is validated server-side against the caller's own documents
   * AND the conversation's permitted knowledge bases before use; a value
   * outside either is treated exactly as a missing one.
   *
   * The model supplies nothing that decides WHERE it may search. `ownerId` and
   * the permitted knowledge-base set are resolved from the session and the
   * conversation, never from this object. See spec 0028's boundary statement.
   */
  documentId?: string
  /**
   * Present when `action === 'read-figure'` (spec 0031 FR9): which figure to
   * look at, and what to look for.
   *
   * `chunkId` is subject to exactly the caveat above — it is a hint the model
   * supplies, validated server-side against the caller's own chunks and
   * permitted knowledge bases in `resolveFigure`. It decides nothing about
   * scope.
   */
  chunkId?: string
  figureQuestion?: string
}

/**
 * Name of the figure tool, duplicated here rather than imported from
 * `figure.ts`.
 *
 * `figure.ts` reaches the database and object storage; this module is pure and
 * unit-tested without either. Importing the constant would drag all of that
 * into every test that parses a decision, to share one string.
 */
export const READ_FIGURE_TOOL_NAME = 'read_figure'

/** The tool schema advertised to the model. */
export const SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_documents',
    description:
      "Search the user's knowledge bases for passages relevant to a query. " +
      'Returns passages with their document title and page number. Call this ' +
      'whenever answering needs information from the documents.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A self-contained search query. Resolve pronouns and references ' +
            'from the conversation — the search has no memory of earlier turns.',
        },
        documentId: {
          type: 'string',
          description:
            'Optional. Restrict the search to one document, by id, when the ' +
            'user named a specific document.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

/** Shape of the subset of an OpenAI-compatible response we depend on. */
interface RawToolCall {
  function?: { name?: string; arguments?: string }
}
export interface RawChoice {
  finish_reason?: string
  message?: {
    content?: string | null
    tool_calls?: RawToolCall[] | null
  }
}

function cleanQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const query = value.trim()
  return query ? query.slice(0, 500) : undefined
}

/** Read a `read_figure` call, or null if it is not usable. */
function parseFigureArguments(argumentsJson: string): PlannerDecision | null {
  let args: unknown
  try {
    args = JSON.parse(argumentsJson)
  } catch {
    return null
  }
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>

  const chunkId = cleanDocumentId(record.chunkId)
  const figureQuestion = cleanQuery(record.question)
  // Both halves are required: a figure with no question gets a blind
  // description, which is precisely the 15-30%-wrong path this tool exists to
  // avoid.
  if (!chunkId || !figureQuestion) return null

  return { action: 'read-figure', chunkId, figureQuestion }
}

function cleanDocumentId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim()
  // Never trusted as scope — only ever used to narrow within an already
  // server-resolved permitted set. Length-capped so a hostile value cannot be
  // used to bloat a query or a log line.
  return id && id.length <= 128 ? id : undefined
}

/**
 * Read a decision out of a native tool call.
 *
 * Returns null when the response contains no usable tool call, so the caller
 * can decide what a non-decision means. It never throws: a malformed
 * `arguments` string is a normal outcome to handle, not an exception.
 */
export function parseToolCallDecision(
  choice: RawChoice | undefined,
): PlannerDecision | null {
  const calls = choice?.message?.tool_calls ?? []

  // A figure read is checked first: when the model asks to look at something,
  // that is the more specific intent and searching again would waste a step it
  // has already decided it does not need.
  const figureCall = calls.find(
    (c) => c.function?.name === READ_FIGURE_TOOL_NAME,
  )
  if (figureCall?.function?.arguments) {
    const decision = parseFigureArguments(figureCall.function.arguments)
    if (decision) return decision
  }

  const call = calls.find((c) => c.function?.name === SEARCH_TOOL.function.name)
  if (!call?.function?.arguments) {
    // No tool call. A finish_reason of 'stop' with content means the model
    // chose to answer rather than search — a legitimate decision, not a
    // failure. Anything else is a non-decision.
    if (choice?.finish_reason === 'stop' && choice.message?.content?.trim()) {
      return { action: 'answer' }
    }
    return null
  }

  let args: unknown
  try {
    args = JSON.parse(call.function.arguments)
  } catch {
    return null
  }
  if (!args || typeof args !== 'object') return null

  const record = args as Record<string, unknown>
  const query = cleanQuery(record.query)
  // A search with no query is not a search. Treated as a non-decision so the
  // caller falls back rather than issuing an empty retrieval.
  if (!query) return null

  return {
    action: 'search',
    query,
    documentId: cleanDocumentId(record.documentId),
  }
}

/**
 * Read a decision out of a JSON object in `content` — the fallback adapter.
 *
 * Tolerates the two things these models actually do: fencing the JSON in a
 * ```json block, and emitting prose before it. It deliberately does NOT try to
 * repair malformed JSON — a repair step turns an honest parse failure into a
 * confident wrong decision.
 *
 * If this adapter is ever used, `max_tokens` must be at least ~1500. At 300 the
 * reasoning preamble is truncated before the JSON is ever reached, which is
 * exactly what produced the earlier false "model cannot emit JSON" conclusion.
 */
export function parseJsonDecision(
  content: string | null | undefined,
): PlannerDecision | null {
  if (!content) return null

  const fenced = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  const bare = content.match(/\{[\s\S]*\}/)
  const candidate = fenced?.[1] ?? bare?.[0]
  if (!candidate) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const record = parsed as Record<string, unknown>
  const action = record.action
  if (action === 'answer') return { action: 'answer' }
  if (action === 'refuse') return { action: 'refuse' }
  if (action !== 'search') return null

  const query = cleanQuery(record.query)
  if (!query) return null
  return {
    action: 'search',
    query,
    documentId: cleanDocumentId(record.documentId),
  }
}
