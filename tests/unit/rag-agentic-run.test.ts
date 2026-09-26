import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/env', () => ({ env: { RAG_PLANNER_MODEL: 'test-planner' } }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/rag/client', () => ({ createChatCompletion: vi.fn() }))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/lib/rag/embed', () => ({ embedQuery: vi.fn() }))

import {
  PLANNER_ASSISTANT_TURN_CHARS,
  historyPrompt,
  withFigureReadings,
} from '@/lib/rag/agentic-run'
import type { LoopStep } from '@/lib/rag/agentic'
import type { RetrievedChunk } from '@/lib/rag/retrieve'

const step = (query: string): LoopStep => ({
  iteration: 1,
  query,
  resultCount: 1,
  bestSimilarity: 0.5,
  found: '    [manual p5] Hot work permits are valid for one shift.',
  elapsedMs: 1,
})

describe('historyPrompt — what the planner is shown', () => {
  it('cuts long assistant turns but keeps user turns whole (#100)', () => {
    const long = 'The probation period is six months. '.repeat(40)
    const prompt = historyPrompt(
      'And can it be extended?',
      [
        { role: 'user', content: 'How long is the probation period?' },
        { role: 'assistant', content: long },
      ],
      [],
      3,
    )
    expect(prompt).toContain('User: How long is the probation period?')
    const assistantLine = prompt
      .split('\n')
      .find((l) => l.startsWith('Assistant: '))!
    expect(assistantLine.length).toBeLessThanOrEqual(
      'Assistant: '.length + PLANNER_ASSISTANT_TURN_CHARS + 1,
    )
    expect(assistantLine.endsWith('…')).toBe(true)
  })

  it('says how many searches are left (#95)', () => {
    expect(historyPrompt('q', [], [], 3)).toContain('You have 3 searches left.')
    expect(historyPrompt('q', [], [step('a')], 3)).toContain(
      'You have 2 searches left.',
    )
  })

  it('asks for a broad last search', () => {
    expect(historyPrompt('q', [], [step('a'), step('b')], 3)).toContain(
      'You have 1 search left. Make it broad enough to cover whatever is still missing.',
    )
  })

  it('says nothing about searches once none are left', () => {
    expect(historyPrompt('q', [], [step('a')], 1)).not.toContain('left')
  })
})

describe('withFigureReadings (spec 0031 FR14, #90)', () => {
  const figure = {
    chunkId: 'fig',
    documentId: 'd1',
    documentTitle: 'report',
    content: 'Figure 3.2: Unplanned downtime by quarter.',
    pageNumber: 3,
    similarity: 0.37,
    kind: 'figure',
  } as RetrievedChunk
  const text = { ...figure, chunkId: 't', kind: 'text' } as RetrievedChunk
  const reading = {
    chunkId: 'fig',
    question: 'Which quarter is lowest?',
    text: 'Q5 is the lowest bar.',
    documentTitle: 'report',
    pageNumber: 3,
  }

  it('gives the figure chunk its reading, labelled as a reading', () => {
    const [out] = withFigureReadings([figure], [reading])
    expect(out!.chunkId).toBe('fig')
    expect(out!.content).toContain(
      "A reading of this figure by a vision model, not the document's own text.",
    )
    expect(out!.content).toContain('Figure label: Figure 3.2')
    expect(out!.content).toContain(
      'Asked: Which quarter is lowest?\nSeen: Q5 is the lowest bar.',
    )
  })

  it('keeps every reading of one figure', () => {
    const [out] = withFigureReadings(
      [figure],
      [reading, { ...reading, question: 'Highest?', text: 'Q3.' }],
    )
    expect(out!.content).toContain('Seen: Q5 is the lowest bar.')
    expect(out!.content).toContain('Asked: Highest?\nSeen: Q3.')
  })

  it('never adds a reading whose figure did not clear the floor', () => {
    // Refusal cannot move: no chunk in, no chunk out.
    expect(withFigureReadings([], [reading])).toEqual([])
    expect(withFigureReadings([text], [reading])).toEqual([text])
  })

  it('leaves text chunks alone even if an id matches', () => {
    const sameId = { ...text, chunkId: 'fig' } as RetrievedChunk
    expect(withFigureReadings([sameId], [reading])).toEqual([sameId])
  })
})
