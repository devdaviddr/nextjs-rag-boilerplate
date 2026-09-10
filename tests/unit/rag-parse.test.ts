import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// parse.ts imports env for the model name and render scale; the pure reader
// under test needs neither, so keep the suite free of process.env setup —
// same approach as tests/unit/rag-extract.test.ts.
vi.mock('@/lib/env', () => ({
  env: {
    RAG_PARSE_MODEL: 'nvidia/nemotron-parse',
    RAG_CRACK_RENDER_SCALE: 2.0,
  },
}))

import { ParseError, elementsFromToolArguments } from '@/lib/rag/parse'

/**
 * Reading what the parser sent back.
 *
 * `parsePage` itself renders a page and calls the endpoint, so it is exercised
 * against the real corpus rather than here. What IS unit-testable — and what
 * has to survive the endpoint changing shape — is the step that decides which
 * of the returned elements can be believed.
 */

const REAL_ARGUMENTS = JSON.stringify([
  JSON.parse(
    readFileSync(
      join(process.cwd(), 'tests/fixtures/parse/landscape-schedule-page.json'),
      'utf8',
    ),
  ),
])

describe('elementsFromToolArguments', () => {
  it('reads the doubly-wrapped array the model actually sends', () => {
    const { elements, dropped } = elementsFromToolArguments(REAL_ARGUMENTS)
    expect(elements).toHaveLength(6)
    expect(dropped).toBe(0)
    expect(elements.map((e) => e.type)).toContain('Table')
  })

  it('reads a bare array too, rather than assuming one shape', () => {
    const bare = JSON.stringify([
      {
        type: 'Text',
        text: 'hello',
        bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      },
    ])
    expect(elementsFromToolArguments(bare).elements).toHaveLength(1)
  })

  it('drops elements with no usable box instead of defaulting one', () => {
    const payload = JSON.stringify([
      {
        type: 'Text',
        text: 'kept',
        bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      },
      { type: 'Text', text: 'no box' },
      { type: 'Text', text: 'partial box', bbox: { xmin: 0, ymin: 0 } },
      {
        type: 'Text',
        text: 'nan box',
        bbox: { xmin: 0, ymin: 0, xmax: null, ymax: 1 },
      },
    ])
    const { elements, dropped } = elementsFromToolArguments(payload)
    expect(elements.map((e) => e.text)).toEqual(['kept'])
    expect(dropped).toBe(3)
  })

  it('drops elements with no text, and counts what it dropped', () => {
    const payload = JSON.stringify([
      {
        type: 'Text',
        text: '   ',
        bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      },
      { type: 'Text', bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } },
      'not an object',
      null,
    ])
    const { elements, dropped } = elementsFromToolArguments(payload)
    expect(elements).toHaveLength(0)
    expect(dropped).toBe(4)
  })

  it('keeps an element type it has never seen', () => {
    // An unknown label must degrade to "treat it as content", never discard
    // the text — the parser is free to add a class we do not know about.
    const payload = JSON.stringify([
      {
        type: 'Formula',
        text: 'E = mc^2',
        bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      },
    ])
    expect(elementsFromToolArguments(payload).elements[0]?.type).toBe('Formula')
  })

  it('throws a ParseError on arguments that are not JSON', () => {
    expect(() => elementsFromToolArguments('{not json')).toThrow(ParseError)
  })

  it('does not treat an inverted box as unusable at this stage', () => {
    // Believing the SHAPE and repairing the GEOMETRY are different jobs.
    // normalize.ts drops inverted boxes; dropping them here would lose the
    // text they carry before dedupe has a chance to prefer a good copy.
    const payload = JSON.stringify([
      {
        type: 'Caption',
        text: 'Figure 1',
        bbox: { xmin: 0.5, ymin: 0, xmax: 0.2, ymax: 1 },
      },
    ])
    expect(elementsFromToolArguments(payload).elements).toHaveLength(1)
  })
})
