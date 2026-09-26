import type { LogCategory, LogContext } from '@/lib/logger'

/**
 * The category of a log line (spec 0042 FR5): the one it names, else one
 * inferred from its message, else from the kind of request it belongs to.
 * The rules cover the lines written before categories existed, so none of
 * those call sites had to change.
 */

export const LOG_CATEGORIES: readonly LogCategory[] = [
  'agent',
  'retrieval',
  'inference',
  'ingestion',
  'auth',
  'settings',
  'system',
]

const RULES: [RegExp, LogCategory][] = [
  [/^ai-settings:/i, 'settings'],
  [/^agentic|planner|^agent\b/i, 'agent'],
  [/^inference request|^upstream error|drafting/i, 'inference'],
  [/rerank|retriev|search|citation/i, 'retrieval'],
  [
    /ingest|crack|pars(e|er)|figure|page|document|extract|embed|chunk/i,
    'ingestion',
  ],
  [
    /login|session|registration|register|password|sign(ed)? ?(in|out)|verification|invite|profile photo|oauth|rate limit|admin action/i,
    'auth',
  ],
]

function isCategory(value: unknown): value is LogCategory {
  return (
    typeof value === 'string' &&
    (LOG_CATEGORIES as readonly string[]).includes(value)
  )
}

export function categorise(
  message: string,
  meta: Record<string, unknown>,
  context: LogContext | undefined,
): LogCategory {
  if (isCategory(meta.category)) return meta.category
  for (const [pattern, category] of RULES) {
    if (pattern.test(message)) return category
  }
  if (context?.kind === 'ingest') return 'ingestion'
  if (context?.kind === 'chat') return 'retrieval'
  return 'system'
}
