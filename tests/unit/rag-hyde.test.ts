import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * HyDE (spec 0033 FR6).
 *
 * Two things are pinned here, and as with reranking the second matters more.
 *
 * 1. That a usable hypothetical replaces the question in the VECTOR channel.
 * 2. That every way this can fail — disabled, thrown, timed out, hedged,
 *    unparseable, empty — falls back to embedding the question, so retrieval
 *    behaves exactly as it does today. That is asserted end to end through
 *    `retrieveForOwner`, not just at the unit boundary, because "embeds the
 *    question" is a claim about the query that gets sent.
 *
 * And one thing is pinned that is not about failure at all: the LEXICAL
 * channel must never see the hypothetical. Invented vocabulary in `to_tsquery`
 * would have the one channel that matches what the user actually typed vote
 * for words they never typed.
 *
 * The model call is mocked throughout. Whether the real prompt produces a
 * usable passage was measured separately against the endpoint — see the
 * docstring in `src/lib/rag/hyde.ts`.
 */

const { mockEnv, createChatCompletion, execute, embedQuery } = vi.hoisted(
  () => ({
    mockEnv: {} as Record<string, unknown>,
    createChatCompletion: vi.fn(),
    execute: vi.fn(),
    embedQuery: vi.fn(),
  }),
)

vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/rag/client', () => ({ createChatCompletion }))
vi.mock('@/db', () => ({ db: { execute } }))
vi.mock('@/lib/rag/embed', () => ({ embedQuery }))

import {
  type HydeBackend,
  HYDE_TOOL,
  hypotheticalQuery,
  llmHyde,
  parseHypothetical,
} from '@/lib/rag/hyde'
import { retrieveForOwner } from '@/lib/rag/retrieve'

/** A passage long enough to clear the "this is not a refusal" floor. */
const PASSAGE =
  'Section 4.2 - Annual Leave. Full-time employees accrue 25 working days of ' +
  'paid annual leave per calendar year, pro-rated for part-time staff.'

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(mockEnv)) delete mockEnv[key]
  Object.assign(mockEnv, {
    RAG_TOP_K: 8,
    RAG_MIN_SIMILARITY: 0.35,
    RAG_HYBRID_CANDIDATES: 20,
    RAG_RRF_K: 60,
    RAG_DOC_SCOPE_MAX_CHUNKS: 24,
    RAG_HYDE_ENABLED: true,
    RAG_HYDE_MODEL: 'hyde-model',
  })
  embedQuery.mockResolvedValue([0.1, 0.2, 0.3])
  execute.mockResolvedValue([])
})

/** The shape a real reply has: the passage in a tool call, `content` empty. */
function toolReply(argumentsJson: string) {
  return {
    choice: {
      finish_reason: 'tool_calls',
      message: {
        content: '',
        tool_calls: [
          { function: { name: 'submit_passage', arguments: argumentsJson } },
        ],
      },
    },
    tokens: 1136,
  }
}

const backendReturning = (passage: string | null): HydeBackend => ({
  name: 'fake',
  generate: vi.fn(async () => passage),
})

// ---------------------------------------------------------------------------
// parseHypothetical
// ---------------------------------------------------------------------------

describe('parseHypothetical', () => {
  it('reads the passage out of a tool call payload', () => {
    expect(parseHypothetical(JSON.stringify({ passage: PASSAGE }))).toBe(
      PASSAGE,
    )
  })

  it('trims surrounding whitespace', () => {
    expect(
      parseHypothetical(JSON.stringify({ passage: `  ${PASSAGE}  ` })),
    ).toBe(PASSAGE)
  })

  it.each([
    'I cannot.',
    'I do not have the document.',
    "I'm sorry, I don't have access to that document.",
    'I cannot answer that question without access to the document.',
  ])('rejects the hedge %j', (hedge) => {
    // A hedge is perfectly valid JSON and would otherwise be embedded as
    // though it were a passage — a vector pointing at apology, which matches
    // the least relevant prose in the corpus. The length floor is the only
    // thing that catches these, so it is pinned against real ones.
    expect(parseHypothetical(JSON.stringify({ passage: hedge }))).toBeNull()
  })

  it('accepts a passage at the short end of what the prompt asks for', () => {
    // The floor must not reject genuine output. Measured passages ran 481-965
    // characters; this is well under that and still admitted.
    const short =
      'Section 4.2 - Annual Leave. Full-time employees accrue 25 working ' +
      'days of paid leave per calendar year, pro-rated for part-time staff.'
    expect(parseHypothetical(JSON.stringify({ passage: short }))).toBe(short)
  })

  it('rejects an empty passage', () => {
    expect(parseHypothetical(JSON.stringify({ passage: '   ' }))).toBeNull()
  })

  it('rejects a non-string passage', () => {
    expect(parseHypothetical(JSON.stringify({ passage: 42 }))).toBeNull()
  })

  it('rejects a payload with no passage field', () => {
    expect(parseHypothetical(JSON.stringify({ text: PASSAGE }))).toBeNull()
  })

  it('rejects prose that is not JSON at all', () => {
    expect(
      parseHypothetical("Here's a thinking process: first I..."),
    ).toBeNull()
  })

  it('rejects null and undefined without throwing', () => {
    expect(parseHypothetical(null)).toBeNull()
    expect(parseHypothetical(undefined)).toBeNull()
  })

  it('caps a runaway generation at chunk length', () => {
    const essay = 'x'.repeat(50_000)
    const out = parseHypothetical(JSON.stringify({ passage: essay }))
    expect(out).not.toBeNull()
    // A vector averaged over far more text than any chunk contains matches
    // nothing in particular.
    expect((out as string).length).toBeLessThanOrEqual(1200)
  })
})

// ---------------------------------------------------------------------------
// llmHyde
// ---------------------------------------------------------------------------

describe('llmHyde', () => {
  it('asks the configured HyDE model, not the chat or planner model', async () => {
    createChatCompletion.mockResolvedValue(
      toolReply(JSON.stringify({ passage: PASSAGE })),
    )

    await llmHyde.generate('How much annual leave?')

    const [, options] = createChatCompletion.mock.calls[0] ?? []
    expect(options.model).toBe('hyde-model')
  })

  it('sends the scoring tool so the reasoning does not land in content', async () => {
    // Measured: without `tools` the reply is "Here's a thinking process:" and
    // no passage at all, 0 of 1 in the probe and consistent with rewrite.ts.
    createChatCompletion.mockResolvedValue(
      toolReply(JSON.stringify({ passage: PASSAGE })),
    )

    await llmHyde.generate('q')

    const [, options] = createChatCompletion.mock.calls[0] ?? []
    expect(options.tools).toEqual([HYDE_TOOL])
  })

  it('returns the passage from the tool call', async () => {
    createChatCompletion.mockResolvedValue(
      toolReply(JSON.stringify({ passage: PASSAGE })),
    )
    expect(await llmHyde.generate('q')).toBe(PASSAGE)
  })

  it('does NOT fall back to reply content', async () => {
    // Deliberately unlike rerank.ts, which does accept content as a fallback.
    // A reasoning model's `content` here is its chain of thought ABOUT writing
    // a passage — meta-text about the query, which is the exact failure mode
    // HyDE exists to fix. Embedding it would be worse than embedding nothing.
    createChatCompletion.mockResolvedValue({
      choice: {
        message: {
          content: JSON.stringify({ passage: PASSAGE }),
          tool_calls: [],
        },
      },
      tokens: 10,
    })
    expect(await llmHyde.generate('q')).toBeNull()
  })

  it('returns null when the tool arguments are unparseable', async () => {
    createChatCompletion.mockResolvedValue(toolReply('not json at all'))
    expect(await llmHyde.generate('q')).toBeNull()
  })

  it('spends no call on an empty question', async () => {
    expect(await llmHyde.generate('   ')).toBeNull()
    expect(createChatCompletion).not.toHaveBeenCalled()
  })

  it('passes a bounded signal so a stalled endpoint cannot hold the query path', async () => {
    createChatCompletion.mockResolvedValue(
      toolReply(JSON.stringify({ passage: PASSAGE })),
    )

    await llmHyde.generate('q')

    const [, options] = createChatCompletion.mock.calls[0] ?? []
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.timeoutMs).toBeGreaterThan(0)
  })

  it('aborts immediately when the caller has already aborted', async () => {
    createChatCompletion.mockResolvedValue(
      toolReply(JSON.stringify({ passage: PASSAGE })),
    )

    await llmHyde.generate('q', AbortSignal.abort())

    const [, options] = createChatCompletion.mock.calls[0] ?? []
    expect(options.signal.aborted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hypotheticalQuery — the failure-open decisions
// ---------------------------------------------------------------------------

describe('hypotheticalQuery', () => {
  it('returns null and spends nothing when disabled', async () => {
    mockEnv.RAG_HYDE_ENABLED = false
    const backend = backendReturning(PASSAGE)

    expect(await hypotheticalQuery('q', { backend })).toBeNull()
    expect(backend.generate).not.toHaveBeenCalled()
  })

  it('returns the hypothetical when the backend produces one', async () => {
    expect(
      await hypotheticalQuery('q', { backend: backendReturning(PASSAGE) }),
    ).toBe(PASSAGE)
  })

  it('returns null when the backend declines', async () => {
    expect(
      await hypotheticalQuery('q', { backend: backendReturning(null) }),
    ).toBeNull()
  })

  it('returns null rather than propagating a thrown backend', async () => {
    const backend: HydeBackend = {
      name: 'fake',
      generate: vi.fn(async () => {
        throw new Error('upstream exploded')
      }),
    }
    expect(await hypotheticalQuery('q', { backend })).toBeNull()
  })

  it('returns null for an empty question without calling the backend', async () => {
    const backend = backendReturning(PASSAGE)
    expect(await hypotheticalQuery('   ', { backend })).toBeNull()
    expect(backend.generate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The guarantees that matter, asserted where the query is built.
// ---------------------------------------------------------------------------

describe('retrieveForOwner with HyDE', () => {
  it('embeds the question, not a hypothetical, when HyDE is off', async () => {
    mockEnv.RAG_HYDE_ENABLED = false

    await retrieveForOwner('owner', 'How much annual leave?', ['kb'])

    expect(embedQuery).toHaveBeenCalledTimes(1)
    expect(embedQuery).toHaveBeenCalledWith('How much annual leave?')
    expect(createChatCompletion).not.toHaveBeenCalled()
  })

  it('embeds the hypothetical instead of the question when HyDE is on', async () => {
    createChatCompletion.mockResolvedValue(
      toolReply(JSON.stringify({ passage: PASSAGE })),
    )

    await retrieveForOwner('owner', 'How much annual leave?', ['kb'])

    expect(embedQuery).toHaveBeenCalledTimes(1)
    expect(embedQuery).toHaveBeenCalledWith(PASSAGE)
  })

  it('embeds the question when the generation fails', async () => {
    // Failure-open, asserted on the query that actually gets built rather than
    // on the return value of the helper.
    createChatCompletion.mockRejectedValue(new Error('upstream exploded'))

    await retrieveForOwner('owner', 'How much annual leave?', ['kb'])

    expect(embedQuery).toHaveBeenCalledWith('How much annual leave?')
  })

  it('embeds the question when the model hedges', async () => {
    createChatCompletion.mockResolvedValue(
      toolReply(JSON.stringify({ passage: 'I do not have the document.' })),
    )

    await retrieveForOwner('owner', 'How much annual leave?', ['kb'])

    expect(embedQuery).toHaveBeenCalledWith('How much annual leave?')
  })

  it('never lets the hypothetical reach the lexical channel', async () => {
    // The vector channel searches on invented vocabulary by design. The
    // lexical channel must not: its entire value is matching what the user
    // actually typed, and `to_tsquery` over fabricated terms would have it
    // vote for passages containing words nobody asked about.
    createChatCompletion.mockResolvedValue(
      toolReply(JSON.stringify({ passage: PASSAGE })),
    )

    await retrieveForOwner('owner', 'How much annual leave?', ['kb'])

    const params = boundParams(execute.mock.calls[0]?.[0])
    expect(params).toContain('How much annual leave?')
    expect(params).not.toContain(PASSAGE)
  })

  it('spends no generation call for an empty knowledge base selection', async () => {
    // Short-circuits before HyDE for the same reason it short-circuits before
    // embedQuery: no selection can produce a row, so nothing is worth spending.
    const out = await retrieveForOwner('owner', 'q', [])

    expect(out).toEqual([])
    expect(createChatCompletion).not.toHaveBeenCalled()
    expect(embedQuery).not.toHaveBeenCalled()
  })
})

interface Chunks {
  value?: unknown
  queryChunks?: Chunks[]
}

/** Bound parameters of a Drizzle `sql` template, in order. */
function boundParams(query: unknown): unknown[] {
  const params: unknown[] = []
  const walk = (chunks: unknown[]): void => {
    for (const c of chunks) {
      if (c === null || c === undefined) continue
      if (typeof c !== 'object') {
        params.push(c)
        continue
      }
      if (Array.isArray(c)) {
        walk(c)
        continue
      }
      const node = c as Chunks
      if (Array.isArray(node.queryChunks)) walk(node.queryChunks)
      else if (
        Array.isArray(node.value) &&
        node.value.every((v) => typeof v === 'string')
      ) {
        // Static SQL text, not a bound value.
      } else if ('value' in node) params.push(node.value)
    }
  }
  walk((query as Chunks)?.queryChunks ?? [])
  return params
}
