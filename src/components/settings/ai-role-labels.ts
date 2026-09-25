import type { AiRole } from '@/lib/ai-settings'

/** How each job is named and explained in Settings (spec 0040 FR2). */
export const ROLE_LABELS: Record<AiRole, { label: string; help: string }> = {
  chat: {
    label: 'Chat',
    help: 'Writes the answers, from the passages retrieval found.',
  },
  planner: {
    label: 'Planner',
    help: 'Decides what to search in agentic mode, and scores passages for the LLM reranker. Needs tool calls.',
  },
  hyde: {
    label: 'HyDE',
    help: 'Drafts a hypothetical passage to search with, when HyDE is on.',
  },
  vision: {
    label: 'Vision',
    help: 'Describes figures and reads charts, when cracking or read-figure is on.',
  },
  parse: {
    label: 'Page parser',
    help: 'Reads page layout from page images when PDFs are cracked.',
  },
  embed: {
    label: 'Embeddings',
    help: 'Turns passages and questions into vectors. Changing it needs a re-index, which is not available yet (#56).',
  },
}
