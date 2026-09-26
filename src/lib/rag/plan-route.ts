import type { RewriteTurn } from './rewrite'

/**
 * Does this question need the planner? (spec 0043 FR1)
 *
 * Measured, the planner helps two kinds of question and no others: a
 * follow-up that leans on the conversation (1/16 found without it, 15/16
 * with it), and a question that asks two things at once. For a standalone
 * question it adds ~11 s and did slightly worse, so those go straight to the
 * fixed pipeline.
 *
 * Pure and free, like `route-intent.ts`: a regex decides the clear cases, and
 * the bias is to plan when unsure. A missed follow-up costs recall; a
 * needless plan costs seconds. Unit-tested against every eval question.
 */

export type PlanReason = 'follow-up' | 'multi-part' | 'standalone'

/** Words that point back at something said earlier. */
const REFERS_BACK =
  /\b(it|its|it's|that|this|these|those|they|them|their|there|he|she|him|her|one|ones|same|above|earlier|previous|former|latter|else|instead)\b/i

/** Openings that only make sense as a reply to the last turn. */
const REPLY_LEAD =
  /^\s*(?:(?:and|but|also|so|or|then)\b|what about\b|how about\b|what if\b|no[,.!\s]|sorry\b|i meant\b)|\bi meant\b/i

/**
 * Two questions at once, or a comparison. The "… and …?" form needs words
 * BEFORE the "and": a leading "And …?" is a follow-up, not two questions.
 */
const MULTI_PART =
  /(\w.*\sand\s.*\?|\?.*\?|,\s*(?:and|or)\b|\b(?:compare[sd]?|comparison|versus|vs\.?|each|both|separately|difference between)\b|\bwhich\b(?:\s+\w+){0,3}\s+(?:more|less|longer|shorter|higher|lower|cheaper|sooner|later)\b|—|;)/i

/** At or under this many words, a question in a conversation is elliptical. */
const SHORT_WORDS = 6

function wordCount(text: string): number {
  return text.toLowerCase().match(/[a-z0-9']+/g)?.length ?? 0
}

export function planRoute(
  question: string,
  turns: readonly RewriteTurn[],
): { plan: boolean; reason: PlanReason } {
  const q = question.trim()
  if (MULTI_PART.test(q)) return { plan: true, reason: 'multi-part' }
  if (
    turns.length > 0 &&
    (REFERS_BACK.test(q) || REPLY_LEAD.test(q) || wordCount(q) <= SHORT_WORDS)
  ) {
    return { plan: true, reason: 'follow-up' }
  }
  return { plan: false, reason: 'standalone' }
}
