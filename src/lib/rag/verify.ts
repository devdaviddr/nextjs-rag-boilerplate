/**
 * Citation verification (spec 0029 FR6).
 *
 * More retrieval means more chances to blur sources together. Without this
 * step, agentic RAG produces **more confident wrong answers** than the fixed
 * pipeline it replaces — which would make the whole change a regression
 * dressed as an improvement.
 *
 * ## One pass, strip — never redraft
 *
 * Spec 0027 drew this as a draft-verify-redraft cycle. That is the same failure
 * mode as an unbounded search loop, moved one step later: a model that keeps
 * failing verification would be asked to redraft indefinitely. So verification
 * runs exactly once, unsupported sentences are removed server-side, and the
 * cost is one extra call regardless of outcome.
 *
 * If stripping empties the answer, that is a refusal — a code path, not a blank
 * message.
 */

export interface VerifiedAnswer {
  /** The answer with unsupported sentences removed. */
  text: string
  /** 1-based citation indices judged unsupported and stripped. */
  strippedIndices: number[]
  /** True when nothing survived — the caller must refuse rather than show this. */
  empty: boolean
}

/**
 * Split an answer into sentences, keeping their trailing punctuation.
 *
 * Deliberately simple. A full sentence tokeniser is a dependency and a
 * behaviour change; this only needs to be good enough to remove a claim without
 * mangling the ones around it. Abbreviations that end in a period will
 * occasionally split early — the cost is a slightly short strip, not a wrong
 * one, because each fragment is still judged on its own citations.
 */
export function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g)
  return parts ? parts.filter((s) => s.trim().length > 0) : []
}

/** Citation markers a sentence carries, as 1-based indices: "[1]", "[2][3]". */
export function citedIndices(sentence: string): number[] {
  const found = sentence.match(/\[(\d+)\]/g)
  if (!found) return []
  return [...new Set(found.map((m) => Number(m.slice(1, -1))))]
}

/**
 * Remove sentences whose every citation was judged unsupported.
 *
 * A sentence citing [1] and [2] survives if EITHER is supported — stripping it
 * would discard a claim that still has a source behind it. A sentence with no
 * citation at all is kept: it is connective prose ("Here is what I found:"),
 * not a claim, and removing it would leave the answer incoherent.
 */
export function stripUnsupported(
  answer: string,
  unsupported: readonly number[],
): VerifiedAnswer {
  const bad = new Set(unsupported)
  if (bad.size === 0) {
    return { text: answer, strippedIndices: [], empty: !answer.trim() }
  }

  const stripped = new Set<number>()
  const kept: string[] = []

  for (const sentence of splitSentences(answer)) {
    const cited = citedIndices(sentence)
    if (cited.length === 0) {
      kept.push(sentence)
      continue
    }
    const supported = cited.filter((i) => !bad.has(i))
    if (supported.length > 0) {
      kept.push(sentence)
    } else {
      for (const i of cited) stripped.add(i)
    }
  }

  const text = kept.join('').trim()
  // Only connective prose left, with every claim removed, is not an answer.
  const hasClaim = kept.some((s) => citedIndices(s).length > 0)

  return {
    text,
    strippedIndices: [...stripped].sort((a, b) => a - b),
    empty: !text || !hasClaim,
  }
}

export const VERIFY_SYSTEM_PROMPT = `You check whether cited sources support the claims made about them.

You are given numbered sources and an answer that cites them.
For each citation number, decide whether the source with that number actually supports what the answer says about it.

Return ONLY a JSON object: {"unsupported": [<numbers>]}
List a number only when the source clearly does NOT support the claim. If a source supports the claim, or you are unsure, do not list it.`

/**
 * Read the verifier's verdict.
 *
 * Fails **open** — an unparseable verdict yields an empty list, so the answer
 * is shown unchanged. That is the deliberate direction: this step exists to
 * catch a model blurring two sources together, not to be a second gate on
 * whether an answer may be shown. The gate is the similarity floor, and it has
 * already run. Failing closed here would let one flaky verification call turn a
 * correctly-grounded answer into a refusal.
 */
export function parseVerdict(content: string | null | undefined): number[] {
  if (!content) return []
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) return []

  try {
    const parsed = JSON.parse(match[0]) as unknown
    if (!parsed || typeof parsed !== 'object') return []
    const list = (parsed as Record<string, unknown>).unsupported
    if (!Array.isArray(list)) return []
    return [
      ...new Set(
        list
          .map((v) => (typeof v === 'number' ? v : Number(v)))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ]
  } catch {
    return []
  }
}
