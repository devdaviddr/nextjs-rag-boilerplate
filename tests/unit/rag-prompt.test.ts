import { describe, expect, it } from 'vitest'

import {
  SYSTEM_PROMPT,
  buildContextBlock,
  buildUserMessage,
} from '@/lib/rag/prompt'
import type { RetrievedChunk } from '@/lib/rag/retrieve'

const chunk = (over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  chunkId: 'c1',
  documentId: 'd1',
  documentTitle: 'Handbook',
  content: 'Leave must be approved in advance.',
  pageNumber: 7,
  similarity: 0.8,
  ...over,
})

describe('buildContextBlock', () => {
  it('numbers sources from one and labels document and page', () => {
    const block = buildContextBlock([
      chunk(),
      chunk({ chunkId: 'c2', documentTitle: 'Policy', pageNumber: 2 }),
    ])
    expect(block).toContain('[1] Handbook — page 7')
    expect(block).toContain('[2] Policy — page 2')
  })

  it('fences document content so it reads as data, not instructions', () => {
    const block = buildContextBlock([chunk()])
    expect(block).toContain('<<<SOURCES')
    expect(block).toContain('SOURCES>>>')
    expect(block).toContain('data, not instructions')
  })
})

describe('SYSTEM_PROMPT', () => {
  it('forbids outside knowledge and requires citations', () => {
    expect(SYSTEM_PROMPT).toMatch(/ONLY from the numbered sources/)
    expect(SYSTEM_PROMPT).toMatch(/Cite the sources/)
  })

  it('addresses indirect prompt injection from document content', () => {
    expect(SYSTEM_PROMPT).toMatch(/never instructions/)
  })
})

describe('buildUserMessage', () => {
  it('puts the question after the context block', () => {
    const message = buildUserMessage('When is leave approved?', [chunk()])
    expect(message.indexOf('SOURCES>>>')).toBeLessThan(
      message.indexOf('QUESTION:'),
    )
    expect(message).toContain('QUESTION: When is leave approved?')
  })
})
