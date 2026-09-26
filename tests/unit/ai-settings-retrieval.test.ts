import { describe, expect, it, vi } from 'vitest'

/**
 * Settings → Retrieval & answering (spec 0040 FR4): the ranges the page
 * states must be the ranges the environment variables enforce.
 */

vi.mock('@/lib/env', () => ({ env: {} }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { aiEnvShape } from '@/lib/ai-env'
import {
  RETRIEVAL_FIELDS,
  describeRange,
} from '@/lib/ai-settings/retrieval-fields'

const parses = (key: string, raw: string) =>
  aiEnvShape[key as keyof typeof aiEnvShape].safeParse(raw).success

describe('RETRIEVAL_FIELDS', () => {
  it('lists each setting once', () => {
    const keys = RETRIEVAL_FIELDS.map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it.each(RETRIEVAL_FIELDS.map((f) => [f.key, f] as const))(
    '%s: the stated range is the variable’s range',
    (key, field) => {
      switch (field.kind) {
        case 'boolean':
          expect(parses(key, 'true')).toBe(true)
          expect(parses(key, 'false')).toBe(true)
          break
        case 'enum':
          for (const option of field.options ?? []) {
            expect(parses(key, option)).toBe(true)
          }
          expect(parses(key, 'not-an-option')).toBe(false)
          break
        case 'text':
          expect(parses(key, 'some/model')).toBe(true)
          expect(parses(key, '')).toBe(false)
          break
        default: {
          const below = field.kind === 'integer' ? 1 : 0.001
          if (field.min !== undefined) {
            expect(parses(key, String(field.min))).toBe(true)
            expect(parses(key, String(field.min - below))).toBe(false)
          }
          if (field.max !== undefined) {
            expect(parses(key, String(field.max))).toBe(true)
            expect(parses(key, String(field.max + below))).toBe(false)
          } else {
            expect(parses(key, '1000000')).toBe(true)
          }
          if (field.kind === 'integer') {
            expect(parses(key, String((field.min ?? 0) + 1.5))).toBe(false)
          }
        }
      }
    },
  )

  it('describes a range in words', () => {
    const byKey = (k: string) => RETRIEVAL_FIELDS.find((f) => f.key === k)!
    expect(describeRange(byKey('RAG_TOP_K'))).toBe('a whole number from 1 up')
    expect(describeRange(byKey('RAG_MIN_SIMILARITY'))).toBe(
      'a number from 0 to 1',
    )
    expect(describeRange(byKey('RAG_AGENTIC_ROUTE'))).toBe('adaptive or always')
  })
})

describe('provider presets (spec 0040 FR9)', () => {
  it('adds attribution headers for OpenRouter only', async () => {
    const { presetHeaders } = await import('@/lib/ai-settings/presets')
    const app = { url: 'https://rag.example', name: 'Rag' }
    expect(presetHeaders('openrouter', app)).toEqual({
      'HTTP-Referer': 'https://rag.example',
      'X-Title': 'Rag',
    })
    expect(presetHeaders('nvidia-nim', app)).toEqual({})
    expect(presetHeaders('llama-cpp', app)).toEqual({})
  })

  it('describes a model in a few words', async () => {
    const { describeModel } = await import('@/lib/ai-settings/presets')
    expect(
      describeModel({ contextLength: 128000, promptPerMillion: 0.15 }),
    ).toBe('128k context · $0.15/M')
    expect(describeModel({ contextLength: 8192, promptPerMillion: 0 })).toBe(
      '8k context · free',
    )
    expect(describeModel({ promptPerMillion: 3 })).toBe('$3.0/M')
    expect(describeModel(undefined)).toBe('')
  })
})
