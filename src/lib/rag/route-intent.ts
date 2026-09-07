/**
 * Should this turn retrieve at all? (spec 0029 FR2)
 *
 * Pure, deterministic and free — no model call, no database. Deliberately so:
 * a model-based router would cost a round trip to decide something a regex
 * already decides for the clear cases, and the fail bias below means the
 * ambiguous cases retrieve either way.
 *
 * ## The fail bias, stated once
 *
 * Wrongly retrieving costs a little latency and some irrelevant context.
 * Wrongly SKIPPING retrieval produces exactly the ungrounded answer this whole
 * system exists to prevent — the model answers from training data with no
 * passage behind it. Those costs are not symmetric, so this router only ever
 * skips retrieval on a high-precision match, and everything else retrieves.
 *
 * Same posture as `WHOLE_DOCUMENT_INTENT` in `scope.ts`, and for the same
 * reason: narrow by construction, not by tuning.
 */

import { normalise } from './scope'

/**
 * Conversational filler that cannot possibly be a question about a document.
 *
 * Anchored at the start AND end: "thanks" skips retrieval, but "thanks, now
 * what does the handbook say about leave" must not. That anchoring is what
 * makes this safe to widen later — a phrase can only match if it is the entire
 * message.
 */
const NO_RETRIEVAL = new RegExp(
  `^(?:${[
    // Gratitude and acknowledgement.
    'thanks?(?: you| a lot| so much)?',
    'ta',
    'cheers',
    'much appreciated',
    'appreciate it',
    'ok(?:ay)?',
    'got it',
    'understood',
    'makes sense',
    'perfect',
    'great',
    'nice',
    'cool',
    'awesome',
    'brilliant',
    'lovely',
    'right',
    'sure',
    'fair enough',
    'no worries',
    'never mind',
    'nvm',
    // Greetings and farewells.
    'hi(?: there)?',
    'hey(?: there)?',
    'hello(?: there)?',
    'good (?:morning|afternoon|evening)',
    'yo',
    'bye(?: bye)?',
    'goodbye',
    'see you(?: later)?',
    'later',
    'good night',
  ].join('|')})$`,
  'i',
)

/**
 * Questions about the assistant itself rather than about any document.
 *
 * Retrieval cannot answer these — there is no passage in a user's PDFs that
 * says what this app can do — so searching for them is pure waste. Kept
 * separate from the filler list because the reasoning is different: filler has
 * no informational content at all, whereas these have content that simply is
 * not in the corpus.
 */
const META_QUESTION =
  /^(?:what can you do|who are you|what are you|how do you work|what is this|help)\b[\s?!.]*$/i

export type TurnRoute = 'retrieve' | 'answer-directly'

/**
 * Route a turn.
 *
 * Returns `'answer-directly'` ONLY for a whole message that is filler or a
 * meta-question. Everything else — including anything unrecognised, empty, or
 * merely odd — returns `'retrieve'`.
 */
export function routeTurn(question: string): TurnRoute {
  const raw = question.trim()
  if (!raw) return 'retrieve'

  // Meta-questions are tested against the raw text so their trailing
  // punctuation is handled explicitly rather than stripped away first.
  if (META_QUESTION.test(raw)) return 'answer-directly'

  // Filler is tested against the normalised form, so "Thanks!" and "thanks"
  // and "  Thanks. " all collapse to the same thing. `normalise` strips
  // punctuation entirely, which is why the anchors above still hold.
  const cleaned = normalise(raw)
  if (!cleaned) return 'retrieve'
  if (NO_RETRIEVAL.test(cleaned)) return 'answer-directly'

  return 'retrieve'
}
