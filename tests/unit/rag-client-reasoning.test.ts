import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * RAG_PLANNER_REASONING (#84): `off` asks the planner to skip its hidden
 * reasoning, on planner-role calls only.
 */

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    NVIDIA_API_KEY: 'test-key',
    RAG_LLM_BASE_URL: 'https://example.invalid/v1',
    RAG_CHAT_MODEL: 'test-chat',
    RAG_PLANNER_MODEL: 'test-planner',
    RAG_PLANNER_REASONING: 'on',
  } as Record<string, unknown>,
}))
vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import { createChatCompletion } from '@/lib/rag/client'

function capture() {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: {},
        }),
      )
    }),
  )
  return bodies
}

afterEach(() => {
  vi.unstubAllGlobals()
  mockEnv.RAG_PLANNER_REASONING = 'on'
})

describe('RAG_PLANNER_REASONING', () => {
  it('sends nothing extra by default', async () => {
    const bodies = capture()
    await createChatCompletion([{ role: 'user', content: 'q' }], {
      role: 'planner',
    })
    expect(bodies[0]).not.toHaveProperty('chat_template_kwargs')
  })

  it('turns thinking off on planner calls when off', async () => {
    mockEnv.RAG_PLANNER_REASONING = 'off'
    const bodies = capture()
    await createChatCompletion([{ role: 'user', content: 'q' }], {
      role: 'planner',
    })
    expect(bodies[0]).toMatchObject({
      model: 'test-planner',
      chat_template_kwargs: { enable_thinking: false },
    })
  })

  it('never touches other jobs’ calls', async () => {
    mockEnv.RAG_PLANNER_REASONING = 'off'
    const bodies = capture()
    await createChatCompletion([{ role: 'user', content: 'q' }])
    await createChatCompletion([{ role: 'user', content: 'q' }], {
      role: 'vision',
    })
    for (const b of bodies) expect(b).not.toHaveProperty('chat_template_kwargs')
  })
})
