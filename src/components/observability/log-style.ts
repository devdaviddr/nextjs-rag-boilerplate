import type { LogCategory } from '@/lib/logger'

/**
 * Colours for the Logs page (spec 0042 FR7). A level is a filled badge, a
 * category a stripe down the left of the line and a coloured label. Both are
 * also written out as text, so colour is never the only signal (NFR5).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LEVEL_STYLE: Record<
  LogLevel,
  { label: string; badge: string; dot: string }
> = {
  error: {
    label: 'Error',
    badge:
      'bg-red-100 text-red-800 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/30',
    dot: 'bg-red-500',
  },
  warn: {
    label: 'Warn',
    badge:
      'bg-amber-100 text-amber-900 ring-amber-600/25 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/30',
    dot: 'bg-amber-500',
  },
  info: {
    label: 'Info',
    badge:
      'bg-sky-100 text-sky-800 ring-sky-600/20 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-400/30',
    dot: 'bg-sky-500',
  },
  debug: {
    label: 'Debug',
    badge:
      'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-500/15 dark:text-slate-300 dark:ring-slate-400/30',
    dot: 'bg-slate-400',
  },
}

export const CATEGORY_STYLE: Record<
  LogCategory,
  { label: string; stripe: string; text: string; chip: string; help: string }
> = {
  agent: {
    label: 'Agent',
    stripe: 'border-l-orange-500',
    text: 'text-orange-700 dark:text-orange-300',
    chip: 'bg-orange-500',
    help: 'What the planner decided: search again, read a figure, or answer.',
  },
  retrieval: {
    label: 'Retrieval',
    stripe: 'border-l-teal-500',
    text: 'text-teal-700 dark:text-teal-300',
    chip: 'bg-teal-500',
    help: 'Searches, reranking and citation checks.',
  },
  inference: {
    label: 'Inference',
    stripe: 'border-l-violet-500',
    text: 'text-violet-700 dark:text-violet-300',
    chip: 'bg-violet-500',
    help: 'Calls to a model provider: timeouts, retries, upstream errors.',
  },
  ingestion: {
    label: 'Ingestion',
    stripe: 'border-l-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-300',
    chip: 'bg-emerald-500',
    help: 'Turning uploaded PDFs into searchable passages.',
  },
  auth: {
    label: 'Auth',
    stripe: 'border-l-rose-500',
    text: 'text-rose-700 dark:text-rose-300',
    chip: 'bg-rose-500',
    help: 'Sign-in, sessions, registration and rate limits.',
  },
  settings: {
    label: 'Settings',
    stripe: 'border-l-indigo-500',
    text: 'text-indigo-700 dark:text-indigo-300',
    chip: 'bg-indigo-500',
    help: 'Changes to AI settings and problems reading them.',
  },
  system: {
    label: 'System',
    stripe: 'border-l-slate-400',
    text: 'text-slate-600 dark:text-slate-300',
    chip: 'bg-slate-400',
    help: 'Everything else.',
  },
}
