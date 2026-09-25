import { describe, expect, it } from 'vitest'

import {
  draftFailureMessage,
  draftRetryDelayMs,
  parseStreamFrame,
} from '@/lib/rag/sse'

describe('parseStreamFrame', () => {
  it('reads content, reasoning, finish reason and usage', () => {
    expect(
      parseStreamFrame(
        '{"choices":[{"delta":{"content":"Hi","reasoning_content":"abc"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
      ),
    ).toEqual({
      kind: 'delta',
      content: 'Hi',
      reasoningChars: 3,
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 2 },
    })
  })

  it('recognises an error frame inside a 200 stream (#43)', () => {
    // The exact frame logged on 2026-09-25 04:01:12Z.
    expect(
      parseStreamFrame(
        ' {"error":{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}}',
      ),
    ).toEqual({
      kind: 'error',
      code: 503,
      message: 'Service temporarily overloaded',
    })
  })

  it('handles error frames without a code or message', () => {
    expect(parseStreamFrame('{"error":"boom"}')).toEqual({
      kind: 'error',
      code: null,
      message: 'boom',
    })
    expect(parseStreamFrame('{"error":{"type":"server_error"}}')).toEqual({
      kind: 'error',
      code: null,
      message: 'server_error',
    })
  })

  it('skips [DONE], blanks and malformed JSON without throwing', () => {
    expect(parseStreamFrame('[DONE]')).toEqual({ kind: 'skip' })
    expect(parseStreamFrame('  ')).toEqual({ kind: 'skip' })
    expect(parseStreamFrame('{"choices":[')).toEqual({ kind: 'skip' })
    expect(parseStreamFrame('null')).toEqual({ kind: 'skip' })
  })

  it('treats a frame with no choices and no error as an empty delta', () => {
    expect(parseStreamFrame('{"id":"x"}')).toMatchObject({
      kind: 'delta',
      content: '',
    })
  })
})

describe('draft retry and failure message', () => {
  it('backs off longer after an upstream error than after an empty stream', () => {
    expect(draftRetryDelayMs(true)).toBeGreaterThan(draftRetryDelayMs(false))
    expect(draftRetryDelayMs(false)).toBeGreaterThanOrEqual(1_000)
  })

  it('tells the user the model is overloaded, not that it was empty', () => {
    const msg = draftFailureMessage({
      code: 503,
      message: 'Service temporarily overloaded',
    })
    expect(msg).toMatch(/overloaded/i)
    expect(msg).toContain('503')
    expect(msg).not.toMatch(/empty answer/i)
  })

  it('keeps the empty-answer message when no upstream error was seen', () => {
    expect(draftFailureMessage(null)).toMatch(/empty answer/i)
  })

  it('reports other upstream errors as a failure with their code', () => {
    const msg = draftFailureMessage({ code: 500, message: 'internal' })
    expect(msg).toContain('500')
    expect(msg).not.toMatch(/overloaded/i)
  })
})
