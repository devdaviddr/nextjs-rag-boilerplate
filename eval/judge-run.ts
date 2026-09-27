import { aiSettings } from '@/lib/ai-settings'
import { createChatCompletion } from '@/lib/rag/client'
import { splitSentences } from '@/lib/rag/verify'

import type { GradedAnswer } from './graded-types'
import {
  DEFAULT_JUDGE_MODEL,
  JUDGE_SAMPLES,
  JUDGE_SYSTEM_PROMPT,
  type JudgeScore,
  aggregate,
  judgeUserMessage,
  parseJudge,
} from './judge'

/**
 * Calling the judge (#120): `JUDGE_SAMPLES` requests at temperature 0 on the
 * planner's connection, with `EVAL_JUDGE_MODEL` (an eval-only setting, read
 * here and nowhere in the app) or `DEFAULT_JUDGE_MODEL`.
 */

export function judgeModel(): string {
  return process.env.EVAL_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL
}

/** Say so when the judge would grade its own model's writing. */
export function judgeModelWarning(): string | null {
  const judge = judgeModel()
  return judge === aiSettings().RAG_CHAT_MODEL
    ? `EVAL_JUDGE_MODEL is the chat model (${judge}); a model grading its own answers is lenient in its own way. Set EVAL_JUDGE_MODEL to another model.`
    : null
}

export async function judgeAnswer(
  answer: Pick<GradedAnswer, 'question' | 'answer' | 'sources'>,
): Promise<JudgeScore> {
  const sentences = splitSentences(answer.answer).length
  const one = async () => {
    try {
      const { choice } = await createChatCompletion(
        [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: judgeUserMessage(answer) },
        ],
        {
          role: 'planner',
          model: judgeModel(),
          temperature: 0,
          maxTokens: 2000,
        },
      )
      return parseJudge(choice.message?.content, sentences)
    } catch {
      return null
    }
  }
  // Samples in parallel: one answer's three calls, then the next answer.
  return aggregate(
    await Promise.all(Array.from({ length: JUDGE_SAMPLES }, one)),
  )
}
