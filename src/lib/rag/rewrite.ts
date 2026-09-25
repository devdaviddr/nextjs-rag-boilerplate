/**
 * Conversation context for reference resolution.
 *
 * There is no separate rewrite CALL any more, and the reason is worth keeping.
 * A standalone rewrite step was built and measured: asked for plain text,
 * `nemotron-3.5-lightning` reasoned for 1500+ tokens and 53 seconds without
 * ever emitting the query; asked via a tool call it answered correctly
 * ("carrying over annual leave") but took **15 seconds** — the entire loop
 * budget, spent before the first search.
 *
 * The planner already formulates its own query through a tool call that was
 * going to happen anyway. Giving it the recent turns lets it resolve "what
 * about carrying it over?" itself, at no extra latency and with one fewer
 * failure mode. See `agentic-run.ts`.
 */

export interface RewriteTurn {
  role: 'user' | 'assistant'
  content: string
}

/** How many prior turns to carry. Enough for a pronoun, not a summary. */
export const REWRITE_CONTEXT_TURNS = 4

/** How much of the previous user turn an outage query carries (#41). */
export const OUTAGE_CONTEXT_CHARS = 300

/**
 * What the loop searches if the planner is unavailable before searching (#41).
 *
 * The literal question always comes first, so a question that stands on its
 * own keeps exactly today's results. When there is an earlier USER turn, a
 * second query prefixes it: "what about Sweden Central?" after "can I tune a
 * model in Australia South East" becomes "can I tune a model in Australia
 * South East what about Sweden Central?" — the resolution the planner would
 * have done, approximated without a model call. Assistant turns are left out:
 * they are long, and their wording would pull retrieval towards the previous
 * answer rather than the new question.
 */
export function outageQueries(
  question: string,
  turns: readonly RewriteTurn[],
): string[] {
  const previous = previousUserTurn(turns)
  return previous ? [question, `${previous} ${question}`] : [question]
}

/**
 * The most recent non-empty user turn, trimmed to `OUTAGE_CONTEXT_CHARS`, or
 * null. It is both the context in `outageQueries` and the yardstick the loop
 * compares context-only results against (`outageBaseline`, #41).
 */
export function previousUserTurn(turns: readonly RewriteTurn[]): string | null {
  const previous = [...turns]
    .reverse()
    .find((t) => t.role === 'user' && t.content.trim().length > 0)
  return previous
    ? previous.content.trim().slice(0, OUTAGE_CONTEXT_CHARS)
    : null
}
