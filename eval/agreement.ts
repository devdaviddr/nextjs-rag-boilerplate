/**
 * Agreement between two raters on the grades 0, 1 and 2 (#120).
 *
 * Percent agreement is exact matches over items. Cohen's kappa is that
 * rate with chance agreement removed. The confusion table is gold (rows)
 * by judge (columns). Items with no label are left out by the caller.
 */

export const GRADE_LABELS = [0, 1, 2] as const

export interface RatedPair {
  gold: number
  judge: number
}

export interface AgreementStats {
  n: number
  matches: number
  /** Matches / n. Null when n is 0. */
  agreement: number | null
  /** Agreement as a percent. Null when n is 0. */
  percentAgreement: number | null
  /**
   * Cohen's κ. Null when n is 0, or when every item shares one label
   * (expected agreement is 1, so kappa is undefined).
   */
  kappa: number | null
  labels: number[]
  /** `confusion[goldIndex][judgeIndex]`, indexes into `labels`. */
  confusion: number[][]
}

export function cohensKappa(
  pairs: readonly RatedPair[],
  labels: readonly number[] = GRADE_LABELS,
): AgreementStats {
  const confusion = labels.map(() => labels.map(() => 0))
  const index = new Map(labels.map((label, i) => [label, i]))
  const empty: AgreementStats = {
    n: 0,
    matches: 0,
    agreement: null,
    percentAgreement: null,
    kappa: null,
    labels: [...labels],
    confusion,
  }
  if (pairs.length === 0) return empty

  for (const pair of pairs) {
    const gold = index.get(pair.gold)
    const judge = index.get(pair.judge)
    if (gold === undefined || judge === undefined) {
      throw new Error(
        `label outside ${labels.join(', ')}: gold ${pair.gold}, judge ${pair.judge}`,
      )
    }
    confusion[gold]![judge]! += 1
  }

  const n = pairs.length
  let matches = 0
  const rowCount = labels.map(() => 0)
  const colCount = labels.map(() => 0)
  for (let g = 0; g < labels.length; g++) {
    for (let j = 0; j < labels.length; j++) {
      const count = confusion[g]![j]!
      rowCount[g]! += count
      colCount[j]! += count
      if (g === j) matches += count
    }
  }

  const agreement = matches / n
  // Expected agreement from the row and column margins.
  let expectedNumerator = 0
  for (let k = 0; k < labels.length; k++) {
    expectedNumerator += rowCount[k]! * colCount[k]!
  }
  const expected = expectedNumerator / (n * n)
  const denominator = 1 - expected
  const kappa =
    Math.abs(denominator) < 1e-12 ? null : (agreement - expected) / denominator

  return {
    n,
    matches,
    agreement,
    percentAgreement: agreement * 100,
    kappa,
    labels: [...labels],
    confusion,
  }
}

export interface ScorePair {
  gold: { faithfulness: number | null; completeness: number }
  judge: { faithfulness: number | null; completeness: number | null }
}

/**
 * Answer-level agreement. Faithfulness is each side's mean claim score,
 * rounded to 0, 1 or 2; an item with no claims on either side is left out.
 * Completeness is the answer grade. This is the same match `agreement()`
 * in `eval/judge.ts` counts, plus kappa and a confusion table.
 */
export function judgePersonAgreement(pairs: readonly ScorePair[]): {
  faithfulness: AgreementStats
  completeness: AgreementStats
} {
  const faithfulness: RatedPair[] = []
  const completeness: RatedPair[] = []
  for (const pair of pairs) {
    if (pair.gold.faithfulness !== null && pair.judge.faithfulness !== null) {
      faithfulness.push({
        gold: Math.round(pair.gold.faithfulness),
        judge: Math.round(pair.judge.faithfulness),
      })
    }
    if (pair.judge.completeness !== null) {
      completeness.push({
        gold: pair.gold.completeness,
        judge: Math.round(pair.judge.completeness),
      })
    }
  }
  return {
    faithfulness: cohensKappa(faithfulness),
    completeness: cohensKappa(completeness),
  }
}

export function formatKappa(kappa: number | null, n: number): string {
  if (n === 0) return 'n/a'
  if (kappa === null) return 'undefined (no variation across labels)'
  return kappa.toFixed(3)
}

export function formatPercent(stats: AgreementStats): string {
  if (stats.n === 0 || stats.percentAgreement === null) return 'n/a (no items)'
  return `${stats.matches}/${stats.n} (${stats.percentAgreement.toFixed(1)}%)`
}

/** Markdown table: gold down the rows, judge across the columns. */
export function confusionTable(
  stats: AgreementStats,
  goldName: string,
  judgeName: string,
): string {
  const labels = stats.labels.map(String)
  const header = `| ${goldName} \\ ${judgeName} | ${labels.join(' | ')} |`
  const rule = `| --- | ${labels.map(() => '---').join(' | ')} |`
  const rows = stats.confusion.map(
    (row, i) => `| ${labels[i]} | ${row.join(' | ')} |`,
  )
  return [header, rule, ...rows].join('\n')
}
