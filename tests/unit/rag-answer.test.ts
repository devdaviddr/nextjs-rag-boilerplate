import { describe, expect, it, vi } from 'vitest'

/**
 * Answering one question (#135), with every side effect faked: retrieval, the
 * model's stream, verification, saving and the run record. What is under test
 * is the order of events and the guarantees between them — above all that
 * nothing retrieved means the model is never called.
 */

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/observability/runs', () => ({
  span: (_name: string, fn: (s: { set(): void }) => unknown) =>
    fn({ set() {} }),
  beginSpan: () => ({ set() {}, end() {} }),
}))

import type { AgenticResult } from '@/lib/rag/agentic-run'
import {
  type AnswerDeps,
  type AnswerState,
  type RunOutcome,
  answerQuestion,
  answerStore,
  gatherEvidence,
} from '@/lib/rag/answer'
import { NO_CONTEXT_ANSWER } from '@/lib/rag/constants'
import type { RetrievedChunk } from '@/lib/rag/retrieve'

const chunk = (id: string, content: string): RetrievedChunk =>
  ({
    chunkId: id,
    documentId: 'doc',
    documentTitle: 'Handbook',
    pageNumber: 1,
    similarity: 0.7,
    content,
  }) as RetrievedChunk

/** An upstream SSE body that streams `parts` as content deltas. */
function sse(
  parts: string[],
  extra: string[] = [],
): ReadableStream<Uint8Array> {
  const lines = [
    ...parts.map(
      (p) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}`,
    ),
    ...extra,
    'data: [DONE]',
  ]
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${lines.join('\n')}\n`))
      controller.close()
    },
  })
}

function setup(over: Partial<AnswerDeps> = {}, agentic = false) {
  const events: Record<string, unknown>[] = []
  const outcomes: RunOutcome[] = []
  const inserted: { content: string; metrics: unknown }[] = []
  const revised: string[] = []
  const deps: AnswerDeps = {
    settings: () => ({
      RAG_AGENTIC_ENABLED: agentic,
      RAG_AGENTIC_ROUTE: 'always',
    }),
    recentTurns: vi.fn().mockResolvedValue([]),
    listReadyDocuments: vi.fn().mockResolvedValue([]),
    retrieveForOwner: vi
      .fn()
      .mockResolvedValue([chunk('c1', 'Leave is 20 days.')]),
    retrieveWholeDocument: vi.fn(),
    runAgenticRetrieval: vi.fn(),
    chatStream: vi.fn().mockResolvedValue(sse(['Leave is ', '20 days [1].'])),
    verify: vi.fn().mockResolvedValue([]),
    chatModelName: () => 'test-model',
    finishRun: (o) => outcomes.push(o),
    sleep: async () => {},
    ...over,
  }
  const store = answerStore(
    {
      insert: async (row) => {
        inserted.push(row)
        return 'msg-1'
      },
      revise: async (_id, content) => {
        revised.push(content)
      },
    },
    {},
  )
  const state: AnswerState = { answer: '', mode: 'search' }
  let closed = false
  const run = () =>
    answerQuestion(
      {
        userId: 'u',
        conversationId: 'c',
        question: 'How much leave do I get?',
        permittedKbIds: ['kb'],
        signal: new AbortController().signal,
      },
      deps,
      {
        send: (e) => events.push(e),
        closed: () => closed,
        finish: () => {
          closed = true
        },
        onReader: () => {},
      },
      store,
      state,
    )
  const types = () => events.map((e) => e.type)
  return { deps, events, outcomes, inserted, revised, state, run, types }
}

describe('answerQuestion', () => {
  it('refuses without calling the model when nothing is retrieved', async () => {
    const t = setup({ retrieveForOwner: vi.fn().mockResolvedValue([]) })
    await t.run()

    expect(t.deps.chatStream).not.toHaveBeenCalled()
    expect(t.deps.verify).not.toHaveBeenCalled()
    expect(t.types()).toEqual(['citations', 'token', 'done'])
    expect(t.events[1]).toEqual({ type: 'token', value: NO_CONTEXT_ANSWER })
    expect(t.inserted.map((r) => r.content)).toEqual([NO_CONTEXT_ANSWER])
    expect(t.outcomes).toEqual([
      expect.objectContaining({
        status: 'refused',
        termination: 'no-evidence',
      }),
    ])
  })

  // Spec 0044 FR9: a registered tool's result is evidence.
  it('answers from a tool result when no passage cleared the floor', async () => {
    const result = {
      chunks: [],
      query: 'q',
      rewritten: false,
      termination: 'planner-answered',
      toolResults: [{ name: 'list_documents', text: '- handbook' }],
    } as unknown as AgenticResult
    const t = setup(
      { runAgenticRetrieval: vi.fn().mockResolvedValue(result) },
      true,
    )
    await t.run()

    expect(t.deps.chatStream).toHaveBeenCalledOnce()
    const [messages] = (t.deps.chatStream as ReturnType<typeof vi.fn>).mock
      .calls[0]!
    expect(messages[1].content).toContain('[tool list_documents]')
    expect(t.deps.verify).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.anything(),
      [{ name: 'list_documents', text: '- handbook' }],
    )
    expect(t.outcomes[0]!.status).toBe('ok')
    // #164: the tools an answer used are kept with it.
    expect(t.inserted[0]!.metrics).toMatchObject({ tools: ['list_documents'] })
  })

  it('still refuses with neither a passage nor a tool result', async () => {
    const result = {
      chunks: [],
      query: 'q',
      rewritten: false,
      termination: 'planner-answered',
    } as unknown as AgenticResult
    const t = setup(
      { runAgenticRetrieval: vi.fn().mockResolvedValue(result) },
      true,
    )
    await t.run()
    expect(t.deps.chatStream).not.toHaveBeenCalled()
    expect(t.outcomes[0]!.status).toBe('refused')
  })

  it('answers on the fixed path: citations, tokens, saved, verified, done', async () => {
    const t = setup()
    await t.run()

    expect(t.types()).toEqual([
      'citations',
      'step',
      'token',
      'token',
      'metrics',
      'step',
      'done',
    ])
    expect(t.state.answer).toBe('Leave is 20 days [1].')
    expect(t.inserted).toHaveLength(1)
    expect(t.inserted[0]!.metrics).toBeTruthy()
    expect(t.deps.verify).toHaveBeenCalledOnce()
    expect(t.deps.runAgenticRetrieval).not.toHaveBeenCalled()
    expect(t.outcomes).toEqual([
      expect.objectContaining({ status: 'ok', mode: 'search' }),
    ])
  })

  it('takes the agentic path when enabled, and records its termination', async () => {
    const result = {
      chunks: [chunk('c1', 'Leave is 20 days.')],
      query: 'annual leave',
      rewritten: false,
      termination: 'planner-unavailable',
    } as AgenticResult
    const t = setup(
      { runAgenticRetrieval: vi.fn().mockResolvedValue(result) },
      true,
    )
    await t.run()

    expect(t.deps.runAgenticRetrieval).toHaveBeenCalledOnce()
    expect(t.deps.retrieveForOwner).not.toHaveBeenCalled()
    // A loop whose planner fell over still answers from what it found.
    expect(t.deps.chatStream).toHaveBeenCalledOnce()
    expect(t.outcomes).toEqual([
      expect.objectContaining({
        status: 'ok',
        mode: 'agentic',
        termination: 'planner-unavailable',
      }),
    ])
  })

  it('strips what verification rejects and revises the saved answer', async () => {
    const t = setup({
      chatStream: vi
        .fn()
        .mockResolvedValue(sse(['Leave is 20 days [1]. It never expires.'])),
      verify: vi.fn().mockResolvedValue([2]),
    })
    await t.run()

    expect(t.inserted[0]!.content).toBe(
      'Leave is 20 days [1]. It never expires.',
    )
    expect(t.revised).toEqual(['Leave is 20 days [1].'])
    expect(t.events).toContainEqual({
      type: 'revision',
      value: 'Leave is 20 days [1].',
      stripped: [],
    })
  })

  it('retries an empty draft once, then answers', async () => {
    const chatStream = vi
      .fn()
      .mockResolvedValueOnce(sse([]))
      .mockResolvedValueOnce(sse(['Leave is 20 days [1].']))
    const t = setup({ chatStream })
    await t.run()

    expect(chatStream).toHaveBeenCalledTimes(2)
    expect(t.state.answer).toBe('Leave is 20 days [1].')
    expect(t.outcomes[0]!.status).toBe('ok')
  })

  it('reports an error, and saves nothing, when both drafts are empty', async () => {
    const t = setup({
      chatStream: vi.fn().mockImplementation(async () => sse([])),
    })
    await t.run()

    expect(t.deps.chatStream).toHaveBeenCalledTimes(2)
    expect(t.types()).toContain('error')
    expect(t.inserted).toEqual([])
    expect(t.outcomes[0]!.status).toBe('error')
  })

  it('saves the partial answer and sends an error when drafting throws', async () => {
    const t = setup({
      chatStream: vi.fn().mockRejectedValue(new Error('upstream down')),
    })
    await t.run()

    expect(t.types().at(-1)).toBe('error')
    expect(t.outcomes).toEqual([
      expect.objectContaining({ status: 'error', error: 'upstream down' }),
    ])
  })
})

describe('gatherEvidence', () => {
  const q = {
    userId: 'u',
    conversationId: 'c',
    question: 'q',
    signal: new AbortController().signal,
  }

  it('returns nothing, without searching, for an empty scope', async () => {
    const { deps } = setup()
    const found = await gatherEvidence(
      { ...q, permittedKbIds: [] },
      () => {},
      deps,
    )
    expect(found.chunks).toEqual([])
    expect(deps.retrieveForOwner).not.toHaveBeenCalled()
  })

  it('reads a whole document for a summary request, and says how much', async () => {
    const whole = [chunk('c1', 'a'), chunk('c2', 'b')]
    const { deps } = setup({
      listReadyDocuments: vi
        .fn()
        .mockResolvedValue([{ id: 'doc-1', title: 'Handbook' }]),
      retrieveWholeDocument: vi
        .fn()
        .mockResolvedValue({ chunks: whole, totalChunks: 10 }),
    })
    const found = await gatherEvidence(
      { ...q, question: 'Summarise the handbook', permittedKbIds: ['kb'] },
      () => {},
      deps,
    )
    expect(found.mode).toBe('document')
    expect(found.coverage).toEqual({ shown: 2, total: 10 })
  })
})

describe('gatherEvidence with tools registered (spec 0044 FR2)', () => {
  it('plans a standalone question under adaptive routing when tools exist', async () => {
    const agentic = {
      chunks: [],
      query: 'q',
      rewritten: false,
      termination: 'planner-answered',
    } as unknown as AgenticResult
    const base = {
      settings: () => ({
        RAG_AGENTIC_ENABLED: true,
        RAG_AGENTIC_ROUTE: 'adaptive' as const,
      }),
      recentTurns: vi.fn().mockResolvedValue([]),
      listReadyDocuments: vi.fn().mockResolvedValue([]),
      retrieveForOwner: vi.fn().mockResolvedValue([]),
      retrieveWholeDocument: vi.fn(),
      runAgenticRetrieval: vi.fn().mockResolvedValue(agentic),
    }
    const q = {
      userId: 'u',
      conversationId: 'c',
      question: 'How many days of annual leave do I get?',
      permittedKbIds: ['kb'],
      signal: new AbortController().signal,
    }

    const without = await gatherEvidence(q, () => {}, {
      ...base,
      hasTools: () => false,
    })
    expect(without.mode).toBe('search')
    expect(base.runAgenticRetrieval).not.toHaveBeenCalled()

    const withTools = await gatherEvidence(q, () => {}, {
      ...base,
      hasTools: () => true,
    })
    expect(withTools.mode).toBe('agentic')
  })
})

describe('gatherEvidence for a document-list question (#168)', () => {
  const q = (question: string) => ({
    userId: 'u',
    conversationId: 'c',
    question,
    permittedKbIds: ['kb-1', 'kb-2'],
    signal: new AbortController().signal,
  })
  const deps = () => ({
    settings: () => ({
      RAG_AGENTIC_ENABLED: true,
      RAG_AGENTIC_ROUTE: 'always' as const,
    }),
    recentTurns: vi.fn().mockResolvedValue([]),
    listReadyDocuments: vi.fn().mockResolvedValue([]),
    retrieveForOwner: vi.fn().mockResolvedValue([]),
    retrieveWholeDocument: vi.fn(),
    runAgenticRetrieval: vi.fn(),
    hasTools: () => false,
    listDocuments: vi.fn().mockResolvedValue('2 documents in 1 knowledge base'),
  })

  it('answers from list_documents, with no search and no planner', async () => {
    const d = deps()
    const evidence = await gatherEvidence(
      q('What documents do you have?'),
      () => {},
      d,
    )
    expect(evidence.toolResults).toEqual([
      { name: 'list_documents', text: '2 documents in 1 knowledge base' },
    ])
    expect(evidence.chunks).toEqual([])
    expect(evidence.mode).toBe('list')
    // Scope comes from the conversation, never from the question.
    expect(d.listDocuments).toHaveBeenCalledWith('u', ['kb-1', 'kb-2'])
    expect(d.retrieveForOwner).not.toHaveBeenCalled()
    expect(d.runAgenticRetrieval).not.toHaveBeenCalled()
  })

  it('leaves a question about what documents say to search', async () => {
    const d = deps()
    d.runAgenticRetrieval.mockResolvedValue({ chunks: [] })
    await gatherEvidence(q('Which documents mention overtime?'), () => {}, d)
    expect(d.listDocuments).not.toHaveBeenCalled()
    expect(d.runAgenticRetrieval).toHaveBeenCalled()
  })

  it('lists nothing for an empty selection', async () => {
    const d = deps()
    const evidence = await gatherEvidence(
      { ...q('What documents do you have?'), permittedKbIds: [] },
      () => {},
      d,
    )
    expect(evidence.toolResults).toBeUndefined()
    expect(d.listDocuments).not.toHaveBeenCalled()
  })
})

describe('answerStore', () => {
  it('saves once, and not at all for an empty answer', async () => {
    const insert = vi.fn().mockResolvedValue('id')
    const store = answerStore({ insert, revise: vi.fn() }, {})
    await store.save('')
    await store.save('first')
    await store.save('second')
    expect(insert).toHaveBeenCalledOnce()
    expect(insert.mock.calls[0]![0].content).toBe('first')
  })

  it('revises only a saved answer', async () => {
    const revise = vi.fn()
    const store = answerStore(
      { insert: vi.fn().mockResolvedValue('id'), revise },
      {},
    )
    await store.revise('too early')
    await store.save('draft')
    await store.revise('verified')
    expect(revise.mock.calls).toEqual([['id', 'verified']])
  })
})
