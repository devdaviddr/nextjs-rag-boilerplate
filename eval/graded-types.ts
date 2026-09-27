/**
 * One graded answer in `eval/graded/` (#119): the question, what the answer
 * was written from, the answer, and its grade against the rubric in
 * `docs/rag.md` (Evaluation → Grading answers). Kept in the repo so answers
 * can be re-scored offline and a model judge calibrated against them (#120).
 */

export interface GradedClaim {
  /** The sentence's number in the answer (1-based), as the verifier numbers it. */
  sentence: number
  text: string
  /** 2 supported, 1 partly supported, 0 unsupported or contradicted. */
  faithfulness: 0 | 1 | 2
  note?: string
}

export interface Grade {
  /** Only the sentences that state a fact; connectives and "the sources do not say" are left out. */
  claims: GradedClaim[]
  /** 2 complete, 1 misses part of what the sources hold, 0 misses the point or refuses wrongly. */
  completeness: 0 | 1 | 2
  completenessNote?: string
  /** Who graded: a drafted grade says so until a person has reviewed it. */
  grader: string
  reviewed: boolean
  gradedAt: string
}

export interface GradedAnswer {
  questionId: string
  type: string
  question: string
  answer: string
  sources: Array<{
    id: string
    document: string
    page: number
    content: string
  }>
  /** The results file and run the answer came from. */
  drawnFrom: { label: string; at: string }
  grade: Grade | null
}

/** Answer-level faithfulness: the mean claim score, 0–2; null with no claims. */
export function faithfulnessOf(grade: Grade): number | null {
  if (grade.claims.length === 0) return null
  return (
    grade.claims.reduce((n, c) => n + c.faithfulness, 0) / grade.claims.length
  )
}
