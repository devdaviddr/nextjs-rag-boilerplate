/**
 * Settings → Retrieval & answering (spec 0040 FR4): which settings the page
 * offers, how each is edited, and its range. Plain data, safe to import from
 * the browser.
 *
 * The ranges repeat the zod fields in `src/lib/ai-env.ts`, which stay the
 * judge: a save is parsed by the same field as the environment variable.
 * They are repeated here so the page can say the allowed range up front, and
 * `tests/unit/ai-settings-retrieval.test.ts` fails if the two disagree.
 */

import type { AiEnvKey } from '@/lib/ai-env'

export type FieldKind = 'boolean' | 'integer' | 'number' | 'enum' | 'text'

export interface RetrievalField {
  key: AiEnvKey
  label: string
  /** One or two plain sentences for the info tip. */
  help: string
  kind: FieldKind
  min?: number
  max?: number
  step?: number
  options?: readonly string[]
  /** Only documents uploaded after the change are affected. */
  newUploadsOnly?: boolean
}

export interface RetrievalGroup {
  id: string
  title: string
  fields: readonly RetrievalField[]
}

export const RETRIEVAL_GROUPS: readonly RetrievalGroup[] = [
  {
    id: 'search',
    title: 'Search',
    fields: [
      {
        key: 'RAG_TOP_K',
        label: 'Passages per answer',
        help: 'How many passages the answer is written from, at most.',
        kind: 'integer',
        min: 1,
      },
      {
        key: 'RAG_MIN_SIMILARITY',
        label: 'Relevance floor',
        help: 'Passages less similar to the question than this are dropped. With none left, the app says it could not find the answer instead of guessing. Tuned for the current embedding model.',
        kind: 'number',
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        key: 'RAG_HYBRID_CANDIDATES',
        label: 'Candidates per search method',
        help: 'How many passages the meaning-based and the keyword search each put forward before they are combined.',
        kind: 'integer',
        min: 1,
      },
      {
        key: 'RAG_RRF_K',
        label: 'Rank fusion constant',
        help: 'How the two search methods are combined. Higher values weigh their rankings more evenly; 60 is the usual choice.',
        kind: 'integer',
        min: 1,
      },
      {
        key: 'RAG_PARENT_ASSEMBLY',
        label: 'Return whole sections',
        help: 'When several passages from one section match, send the section as one passage instead of fragments.',
        kind: 'boolean',
      },
      {
        key: 'RAG_HYDE_ENABLED',
        label: 'Search with a drafted answer (HyDE)',
        help: 'Drafts a likely answer first and searches with that. Costs one model call per question.',
        kind: 'boolean',
      },
      {
        key: 'RAG_DOC_SCOPE_MAX_CHUNKS',
        label: 'Passages for a whole-document request',
        help: 'How much of a document "Summarise the handbook" can read, in passages.',
        kind: 'integer',
        min: 1,
      },
    ],
  },
  {
    id: 'agentic',
    title: 'Agentic search',
    fields: [
      {
        key: 'RAG_AGENTIC_ENABLED',
        label: 'Agentic search',
        help: 'A planner model decides what to search for and searches again if needed. Much better on follow-ups and two-part questions, and slower.',
        kind: 'boolean',
      },
      {
        key: 'RAG_AGENTIC_ROUTE',
        label: 'When to plan',
        help: '"adaptive" sends only follow-ups and two-part questions to the planner; "always" plans every question.',
        kind: 'enum',
        options: ['adaptive', 'always'],
      },
      {
        key: 'RAG_MAX_SEARCHES',
        label: 'Searches per question',
        help: 'The most searches the planner may run for one question, figure reads included.',
        kind: 'integer',
        min: 1,
      },
      {
        key: 'RAG_MAX_LOOP_MS',
        label: 'Time limit (ms)',
        help: 'How long searching may take for one question, before the answer is written. Raised to 45000 when figure reading is on.',
        kind: 'integer',
        min: 1,
      },
      {
        key: 'RAG_MAX_LOOP_TOKENS',
        label: 'Token limit',
        help: 'The most tokens the planner may use for one question. Raised to 30000 when figure reading is on.',
        kind: 'integer',
        min: 1,
      },
      {
        key: 'RAG_PLANNER_CALL_MS',
        label: 'Planner call limit (ms)',
        help: 'The longest one planner decision may take. 0 means no limit of its own beyond the time limit.',
        kind: 'integer',
        min: 0,
        max: 120_000,
      },
      {
        key: 'RAG_PLANNER_REASONING',
        label: 'Planner reasoning',
        help: '"off" skips the planner’s hidden reasoning, which is faster. Only some providers accept the switch.',
        kind: 'enum',
        options: ['on', 'off'],
      },
      {
        key: 'RAG_AGENTIC_CONFIDENT_SIMILARITY',
        label: 'Stop early on a strong match',
        help: 'A first search at least this similar ends the search without asking the planner again. 1 turns it off.',
        kind: 'number',
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        key: 'RAG_AGENTIC_FLOOR_STEP',
        label: 'Floor rise per extra search',
        help: 'How much the relevance floor rises with each extra search, so more tries do not mean more lucky matches.',
        kind: 'number',
        min: 0,
        step: 0.01,
      },
      {
        key: 'RAG_READ_FIGURE_ENABLED',
        label: 'Read figures',
        help: 'Lets the planner ask a vision model what a chart shows. Needs document cracking, and makes figure questions take 20–60 s.',
        kind: 'boolean',
      },
    ],
  },
  {
    id: 'rerank',
    title: 'Reranking',
    fields: [
      {
        key: 'RAG_RERANK_ENABLED',
        label: 'Rerank passages',
        help: 'Reorders the passages found by reading each one next to the question. More accurate ordering, and slower.',
        kind: 'boolean',
      },
      {
        key: 'RAG_RERANK_BACKEND',
        label: 'Reranker',
        help: '"local" runs a small model in the app; "llm" asks the planner’s model.',
        kind: 'enum',
        options: ['local', 'llm'],
      },
      {
        key: 'RAG_RERANK_LOCAL_MODEL',
        label: 'Local reranker model',
        help: 'The Hugging Face model the local reranker downloads and runs.',
        kind: 'text',
      },
      {
        key: 'RAG_RERANK_CANDIDATES',
        label: 'Passages to rerank',
        help: 'How many passages the reranker reads before the best are kept.',
        kind: 'integer',
        min: 1,
      },
    ],
  },
  {
    id: 'uploads',
    title: 'Document processing',
    fields: [
      {
        key: 'RAG_CHUNK_TOKENS',
        label: 'Passage size (tokens)',
        help: 'How long each indexed passage is.',
        kind: 'integer',
        min: 1,
        newUploadsOnly: true,
      },
      {
        key: 'RAG_CHUNK_OVERLAP_TOKENS',
        label: 'Passage overlap (tokens)',
        help: 'How much neighbouring passages share. Must be smaller than the passage size.',
        kind: 'integer',
        min: 0,
        newUploadsOnly: true,
      },
      {
        key: 'RAG_CRACK_ENABLED',
        label: 'Read tables, figures and scans',
        help: 'Sends pages with tables, charts or no text layer to a parsing model, so their content is indexed. Costs model calls at upload.',
        kind: 'boolean',
        newUploadsOnly: true,
      },
    ],
  },
]

export const RETRIEVAL_FIELDS: readonly RetrievalField[] =
  RETRIEVAL_GROUPS.flatMap((g) => g.fields)

export function retrievalField(key: string): RetrievalField | undefined {
  return RETRIEVAL_FIELDS.find((f) => f.key === key)
}

/** "a whole number from 1", "a number from 0 to 1", "adaptive or always". */
export function describeRange(field: RetrievalField): string {
  switch (field.kind) {
    case 'boolean':
      return 'on or off'
    case 'enum':
      return (field.options ?? []).join(' or ')
    case 'text':
      return 'a model name'
    default: {
      const noun = field.kind === 'integer' ? 'a whole number' : 'a number'
      if (field.min !== undefined && field.max !== undefined) {
        return `${noun} from ${field.min} to ${field.max}`
      }
      if (field.min !== undefined) return `${noun} from ${field.min} up`
      return noun
    }
  }
}
