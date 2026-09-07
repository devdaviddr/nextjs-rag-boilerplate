import { describe, expect, it } from 'vitest'

import {
  type RawChoice,
  parseJsonDecision,
  parseToolCallDecision,
} from '@/lib/rag/planner'

function toolChoice(args: string, name = 'search_documents'): RawChoice {
  return {
    finish_reason: 'tool_calls',
    message: {
      content: null,
      tool_calls: [{ function: { name, arguments: args } }],
    },
  }
}

describe('parseToolCallDecision', () => {
  it('reads a well-formed search call', () => {
    const decision = parseToolCallDecision(
      toolChoice('{"query":"annual leave carry over"}'),
    )
    expect(decision).toEqual({
      action: 'search',
      query: 'annual leave carry over',
      documentId: undefined,
    })
  })

  it('carries a documentId hint through', () => {
    const decision = parseToolCallDecision(
      toolChoice('{"query":"notice period","documentId":"doc-1"}'),
    )
    expect(decision?.documentId).toBe('doc-1')
  })

  it('treats a stop with content as a decision to answer', () => {
    const decision = parseToolCallDecision({
      finish_reason: 'stop',
      message: { content: 'You are welcome.' },
    })
    expect(decision).toEqual({ action: 'answer' })
  })

  /**
   * The failure the whole two-adapter design exists to absorb. Returning null
   * rather than throwing lets the caller fall back deliberately; a thrown error
   * here would surface as a 500 on a request that could still be answered.
   */
  it('returns null for unparseable arguments rather than throwing', () => {
    expect(
      parseToolCallDecision(toolChoice('{"query": "unterminated')),
    ).toBeNull()
    expect(parseToolCallDecision(toolChoice('not json at all'))).toBeNull()
    expect(parseToolCallDecision(toolChoice('null'))).toBeNull()
    expect(parseToolCallDecision(toolChoice('[]'))).toBeNull()
  })

  it('returns null for a search with no usable query', () => {
    expect(parseToolCallDecision(toolChoice('{}'))).toBeNull()
    expect(parseToolCallDecision(toolChoice('{"query":"   "}'))).toBeNull()
    expect(parseToolCallDecision(toolChoice('{"query":123}'))).toBeNull()
  })

  it('ignores a tool call for some other function', () => {
    expect(
      parseToolCallDecision(toolChoice('{"query":"x"}', 'delete_everything')),
    ).toBeNull()
  })

  it('returns null for an empty or absent choice', () => {
    expect(parseToolCallDecision(undefined)).toBeNull()
    expect(parseToolCallDecision({})).toBeNull()
    expect(
      parseToolCallDecision({
        finish_reason: 'stop',
        message: { content: '  ' },
      }),
    ).toBeNull()
  })

  it('caps an over-long query and documentId rather than passing them through', () => {
    const decision = parseToolCallDecision(
      toolChoice(
        JSON.stringify({ query: 'q'.repeat(900), documentId: 'd'.repeat(200) }),
      ),
    )
    expect(decision?.query).toHaveLength(500)
    // An over-long id is dropped entirely, not truncated into a different id.
    expect(decision?.documentId).toBeUndefined()
  })

  /**
   * The model may emit anything at all in these fields. None of it decides
   * scope — that is resolved server-side — but the parser must not pass
   * scope-shaped keys through as if they meant something.
   */
  it('ignores scope-shaped fields the model has no business supplying', () => {
    const decision = parseToolCallDecision(
      toolChoice(
        '{"query":"x","ownerId":"someone-else","userId":"u2","knowledgeBaseIds":["kb-x"]}',
      ),
    )
    expect(decision).toEqual({
      action: 'search',
      query: 'x',
      documentId: undefined,
    })
    expect(decision).not.toHaveProperty('ownerId')
    expect(decision).not.toHaveProperty('userId')
    expect(decision).not.toHaveProperty('knowledgeBaseIds')
  })
})

describe('parseJsonDecision', () => {
  it('reads a bare JSON object', () => {
    expect(parseJsonDecision('{"action":"search","query":"leave"}')).toEqual({
      action: 'search',
      query: 'leave',
      documentId: undefined,
    })
  })

  it('reads JSON out of a fenced block', () => {
    const content =
      'Here is my plan:\n```json\n{"action":"search","query":"leave"}\n```'
    expect(parseJsonDecision(content)?.query).toBe('leave')
  })

  it('reads JSON that follows a reasoning preamble', () => {
    const content =
      'Okay, let\'s tackle this. The user wants the refund window.\n{"action":"search","query":"refund window"}'
    expect(parseJsonDecision(content)?.query).toBe('refund window')
  })

  it('reads answer and refuse actions', () => {
    expect(parseJsonDecision('{"action":"answer"}')).toEqual({
      action: 'answer',
    })
    expect(parseJsonDecision('{"action":"refuse"}')).toEqual({
      action: 'refuse',
    })
  })

  /**
   * A truncated reasoning preamble is the real failure shape measured on these
   * models at a small max_tokens — not garbled JSON. It must parse to null so
   * the caller falls back, never to a half-read decision.
   */
  it('returns null for a truncated reasoning preamble with no JSON', () => {
    expect(
      parseJsonDecision(
        "Okay, let's tackle this user query. The user is asking about the refund policy regarding orders returned after 30 days. They specifically want me to search the knowledge base and not guess, so I need",
      ),
    ).toBeNull()
  })

  it('returns null rather than repairing malformed JSON', () => {
    expect(parseJsonDecision('{"action":"search","query":')).toBeNull()
    expect(parseJsonDecision('{action: search}')).toBeNull()
  })

  it('returns null for empty, absent or actionless content', () => {
    expect(parseJsonDecision(null)).toBeNull()
    expect(parseJsonDecision(undefined)).toBeNull()
    expect(parseJsonDecision('')).toBeNull()
    expect(parseJsonDecision('{"query":"no action given"}')).toBeNull()
    expect(parseJsonDecision('{"action":"drop_table"}')).toBeNull()
  })

  it('returns null for a search with no query', () => {
    expect(parseJsonDecision('{"action":"search"}')).toBeNull()
    expect(parseJsonDecision('{"action":"search","query":""}')).toBeNull()
  })
})
