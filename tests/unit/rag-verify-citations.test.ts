import { describe, expect, it, vi } from 'vitest'

/**
 * #42 — verification must not hold the composer for minutes. It runs after
 * the answer has streamed and fails open, so it gets one short attempt.
 */

const { createChatCompletion } = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}))

vi.mock('@/lib/env', () => ({ env: { RAG_PLANNER_MODEL: 'test-planner' } }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/rag/client', () => ({ createChatCompletion }))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/lib/rag/embed', () => ({ embedQuery: vi.fn() }))

import { VERIFY_TIMEOUT_MS, verifyCitations } from '@/lib/rag/agentic-run'
import type { RetrievedChunk } from '@/lib/rag/retrieve'

const chunk = {
  chunkId: 'c1',
  documentId: 'd1',
  documentTitle: 'handbook',
  content: 'Annual leave is 20 days.',
  pageNumber: 1,
  similarity: 0.6,
} as RetrievedChunk

describe('verifyCitations', () => {
  it('asks for one attempt with a short deadline', async () => {
    createChatCompletion.mockResolvedValueOnce({
      choice: { message: { content: '{"unsupported":[]}' } },
      tokens: 1,
    })
    await verifyCitations(
      'You get 20 days [1].',
      [chunk],
      new AbortController().signal,
    )

    const options = createChatCompletion.mock.calls[0]![1]
    expect(options).toMatchObject({
      model: 'test-planner',
      maxAttempts: 1,
      timeoutMs: VERIFY_TIMEOUT_MS,
    })
    expect(VERIFY_TIMEOUT_MS).toBeLessThanOrEqual(15_000)
  })

  it('fails open when the planner times out', async () => {
    createChatCompletion.mockRejectedValueOnce(
      new Error('no response within 12000ms'),
    )
    await expect(
      verifyCitations(
        'You get 20 days [1].',
        [chunk],
        new AbortController().signal,
      ),
    ).resolves.toEqual([])
  })
})
