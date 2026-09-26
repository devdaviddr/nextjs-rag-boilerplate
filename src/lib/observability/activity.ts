/**
 * What the chat's Agent activity drawer shows (spec 0042 FR12): each log line
 * of an answer in plain words, and its steps. Everyone gets the plain line;
 * only admins get the line's details, already redacted. Pure, so it is shared
 * by the live stream and the history route, and unit-tested.
 */

export interface ActivityLine {
  kind: 'line'
  time: string
  level: 'debug' | 'info' | 'warn' | 'error'
  category: string
  text: string
  /** Admins only. */
  detail?: Record<string, unknown>
}

export interface ActivityStep {
  kind: 'step'
  phase: 'start' | 'end'
  key: number
  parentKey: number | null
  name: string
  offsetMs: number
  durationMs?: number
  status?: 'ok' | 'error' | 'cancelled'
  model?: string | null
  tokens?: number | null
}

export type ActivityEvent = ActivityLine | ActivityStep

/** Most an answer streams; later events are dropped, the answer never is. */
export const MAX_ACTIVITY_EVENTS = 300

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v : undefined
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

function quote(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return `“${t.length > max ? `${t.slice(0, max)}…` : t}”`
}

/**
 * A log line in plain words. Known lines get a sentence; anything else keeps
 * its own message, which is already written for a person.
 */
export function plainLine(
  message: string,
  meta: Record<string, unknown>,
): string {
  const query = str(meta.query)
  if (message === 'Skipping the planner') {
    return 'A standalone question: searching directly, without the planner'
  }
  if (message === 'Planning this question') {
    return meta.route === 'multi-part'
      ? 'This question asks more than one thing, so the planner will search for each'
      : meta.route === 'follow-up'
        ? 'A follow-up: the planner will work out what it refers to'
        : 'Planning the searches for this question'
  }
  if (message.startsWith('Planner chose to search')) {
    return query ? `Decided to search for ${quote(query)}` : 'Decided to search'
  }
  if (message.startsWith('Planner chose to answer')) {
    return 'Decided it had found enough to answer'
  }
  if (message.startsWith('Planner chose to refuse')) {
    return 'Decided the documents do not answer this'
  }
  if (message.startsWith('Planner chose to read figure')) {
    return 'Decided to read a figure more closely'
  }
  if (message === 'Planner gave no usable decision') {
    return 'The planner gave no usable answer; carrying on without it'
  }
  if (message.startsWith('Search found')) {
    const results = num(meta.results) ?? 0
    const best = num(meta.bestSimilarity)
    const found =
      results === 0
        ? 'Found nothing'
        : `Found ${results} passage${results === 1 ? '' : 's'}`
    return `${found}${best !== undefined ? ` (best match ${best.toFixed(2)})` : ''}${query ? ` for ${quote(query, 50)}` : ''}`
  }
  if (message.startsWith('Reranked')) {
    return meta.topChanged
      ? `Re-ordered the passages by relevance; a different one came out on top`
      : `Re-ordered the passages by relevance`
  }
  if (message.startsWith('HyDE drafted')) {
    return 'Drafted an example answer to search with'
  }
  if (message === 'Agentic retrieval') {
    const searches = num(meta.searches) ?? 0
    const chunks = num(meta.chunkCount) ?? 0
    const kept = `${searches} search${searches === 1 ? '' : 'es'}, ${chunks} passage${chunks === 1 ? '' : 's'} kept`
    switch (meta.termination) {
      case 'time-budget':
        return `Stopped searching at the time limit: ${kept}`
      case 'confident':
        return `Found a strong match first time, so no second decision: ${kept}`
      case 'planner-slow':
        return `The planner was slow, so it stopped with what it had: ${kept}`
      default:
        return `Finished searching: ${kept}`
    }
  }
  if (message === 'Agentic planner unavailable') {
    // Logged twice when it happens: once for the failed call, once for the
    // fallback. Each line says its own part.
    const reason = str(meta.reason) ?? ''
    if (/fall(ing)? back/i.test(reason)) {
      const searches = /falling back to (\d+) searches/i.exec(reason)?.[1]
      return searches
        ? `Carried on without the planner: ${searches} plain searches, using the conversation`
        : 'Carried on without the planner: one plain search instead'
    }
    const error = str(meta.errorMessage)
    if (error && /took too long/i.test(error)) {
      return 'The planner was too slow, so the app went ahead without it'
    }
    if (error && /time budget/i.test(error)) {
      return 'The planner ran out of time before deciding'
    }
    return error && error !== 'undefined'
      ? `The planner failed: ${error}`
      : 'The planner failed'
  }
  if (message.startsWith('Upstream error inside the drafting stream')) {
    return 'The model provider was busy while writing the answer'
  }
  if (message.startsWith('Drafting returned nothing; retrying once')) {
    return 'The answer came back empty; trying once more'
  }
  if (message.startsWith('Inference request retrying')) {
    return 'The model provider was busy; retrying'
  }
  if (message.startsWith('Inference request timed out')) {
    return 'A model call took too long; retrying'
  }
  if (message.startsWith('Stripped unsupported citations')) {
    return 'Removed a claim its source did not support'
  }
  if (message.startsWith('rerank'))
    return 'Reranking failed; kept the search order'
  if (message.startsWith('hyde'))
    return 'HyDE failed; searched with the question itself'
  return message
}

/** Lines that only repeat what the steps already show, or are too internal. */
export function worthShowing(message: string): boolean {
  return message !== 'Agentic trace'
}

export function toActivityLine(
  line: {
    time: string
    level: ActivityLine['level']
    category: string
    message: string
    meta: Record<string, unknown>
  },
  admin: boolean,
): ActivityLine {
  return {
    kind: 'line',
    time: line.time,
    level: line.level,
    category: line.category,
    text: plainLine(line.message, line.meta),
    ...(admin ? { detail: { message: line.message, ...line.meta } } : {}),
  }
}
