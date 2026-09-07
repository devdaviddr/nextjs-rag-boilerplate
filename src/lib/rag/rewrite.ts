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
