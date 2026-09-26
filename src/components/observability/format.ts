/** Shared wording and colours for the run pages (spec 0042 FR9, FR10). */

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–'
  if (ms < 1_000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1_000)} s`
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export const RUN_STATUS: Record<
  string,
  { label: string; className: string; help: string }
> = {
  ok: {
    label: 'Answered',
    className:
      'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
    help: 'Finished normally.',
  },
  refused: {
    label: 'No match',
    className:
      'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200',
    help: 'Nothing in the documents was close enough, so the app said so instead of guessing.',
  },
  error: {
    label: 'Failed',
    className: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
    help: 'Something went wrong, usually the model provider.',
  },
  cancelled: {
    label: 'Cancelled',
    className:
      'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300',
    help: 'The person left, or the work was taken over by another worker.',
  },
}

export function runStatus(status: string) {
  return (
    RUN_STATUS[status] ?? {
      label: status,
      className: 'bg-muted text-muted-foreground',
      help: '',
    }
  )
}

/** Plain names for the steps a run records. */
export const STEP_LABEL: Record<string, string> = {
  retrieve: 'Find passages',
  plan: 'Planner decides',
  search: 'Search',
  hyde: 'HyDE draft',
  'embed-question': 'Embed question',
  'search-index': 'Search the index',
  rerank: 'Rerank',
  'read-figure': 'Read a figure',
  draft: 'Write the answer',
  verify: 'Check citations',
  download: 'Download PDF',
  extract: 'Extract and chunk',
  embed: 'Embed passages',
  store: 'Store passages',
}

/** Why an agentic search loop stopped, in words. */
export const TERMINATION_LABEL: Record<string, string> = {
  'planner-answered': 'Planner had enough',
  // No longer produced (#96); kept so runs recorded before then still read.
  'planner-refused': 'Planner found nothing',
  'repeated-query': 'Planner repeated a search',
  'search-budget': 'Search limit reached',
  'time-budget': 'Time budget ran out',
  'token-budget': 'Token budget ran out',
  'planner-unavailable': 'Planner unavailable, fell back',
  confident: 'Strong first match',
  'planner-slow': 'Planner slow, kept what it had',
  'whole-document': 'Whole document',
  'no-scope': 'No knowledge base',
  'no-evidence': 'Nothing found',
}

export function termination(value: string | null): string {
  if (!value) return '–'
  return TERMINATION_LABEL[value] ?? value.replace(/-/g, ' ')
}
