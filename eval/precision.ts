import { citedIndices, splitSentences } from '@/lib/rag/verify'

/**
 * Citation precision for `--answers` (#118): how much of each generated
 * answer the verifier accepts.
 *
 * The verifier is the app's (`verifyMessages`), asked the same question,
 * but its verdict is read strictly: a timeout or an unreadable reply is "no
 * verdict", counted on its own, never as "all supported", which is how the
 * app fails open. The prompt lists a sentence only when a source "clearly
 * does NOT support" it, so `unsupported` is a floor, and the rates below a
 * ceiling.
 */

export interface Verification {
  /** `none`: the verifier gave no readable verdict. */
  status: 'ok' | 'none'
  /** Sentences in the answer, as the verifier numbered them. */
  sentences: number
  /** Sentences carrying at least one [n] citation. */
  cited: number
  /** Sentence numbers (1-based) the verifier said the sources do not support. */
  unsupported: number[]
  /** How many of those carried a citation. */
  unsupportedCited: number
}

/** Score one answer against a verdict (null when there was none). */
export function scoreVerification(
  answer: string,
  verdict: number[] | null,
): Verification {
  const sentences = splitSentences(answer)
  const citedSet = new Set(
    sentences
      .map((s, i) => (citedIndices(s).length > 0 ? i + 1 : 0))
      .filter(Boolean),
  )
  const unsupported = (verdict ?? []).filter(
    (n) => n >= 1 && n <= sentences.length,
  )
  return {
    status: verdict === null ? 'none' : 'ok',
    sentences: sentences.length,
    cited: citedSet.size,
    unsupported,
    unsupportedCited: unsupported.filter((n) => citedSet.has(n)).length,
  }
}

export interface PrecisionRow {
  answers: number
  /** Answers the verifier gave no verdict on; left out of the rates. */
  noVerdict: number
  sentences: number
  unsupported: number
  /** 1 − unsupported / sentences, over answers with a verdict. */
  supportRate: number | null
  cited: number
  unsupportedCited: number
  /** 1 − unsupported cited sentences / cited sentences. */
  citationPrecision: number | null
}

const rate = (bad: number, total: number) =>
  total === 0 ? null : Number((1 - bad / total).toFixed(3))

export function precisionRow(
  items: readonly { verification?: Verification }[],
): PrecisionRow {
  const scored = items.filter((i) => i.verification)
  const withVerdict = scored.filter((i) => i.verification!.status === 'ok')
  const sum = (f: (v: Verification) => number) =>
    withVerdict.reduce((n, i) => n + f(i.verification!), 0)
  const sentences = sum((v) => v.sentences)
  const unsupported = sum((v) => v.unsupported.length)
  const cited = sum((v) => v.cited)
  const unsupportedCited = sum((v) => v.unsupportedCited)
  return {
    answers: scored.length,
    noVerdict: scored.length - withVerdict.length,
    sentences,
    unsupported,
    supportRate: rate(unsupported, sentences),
    cited,
    unsupportedCited,
    citationPrecision: rate(unsupportedCited, cited),
  }
}

/** Per slice (question type) and pooled. */
export function precisionBySlice(
  items: readonly { type: string; verification?: Verification }[],
): Record<string, PrecisionRow> {
  const slices = [...new Set(items.map((i) => i.type))].sort()
  const out: Record<string, PrecisionRow> = {}
  for (const slice of slices) {
    out[slice] = precisionRow(items.filter((i) => i.type === slice))
  }
  out.all = precisionRow(items)
  return out
}

/** The table printed after the answer checks. */
export function formatPrecision(rows: Record<string, PrecisionRow>): string[] {
  const pct = (n: number | null) => (n === null ? '   –' : n.toFixed(3))
  return [
    '  slice        answers  no-verdict  support  citation precision',
    ...Object.entries(rows).map(
      ([slice, r]) =>
        `  ${slice.padEnd(12)} ${String(r.answers).padStart(7)} ${String(r.noVerdict).padStart(11)}    ${pct(r.supportRate)}  ${pct(r.citationPrecision)}  (${r.unsupportedCited}/${r.cited} cited sentences unsupported)`,
    ),
  ]
}
