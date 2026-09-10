import { describe, expect, it, vi } from 'vitest'

// figure.ts reaches the database, object storage and the vision endpoint. The
// two pure functions under test need none of them, so the module's env and db
// dependencies are stubbed exactly as tests/unit/rag-extract.test.ts does.
vi.mock('@/lib/env', () => ({
  env: {
    RAG_VISION_MODEL: 'meta/llama-3.2-11b-vision-instruct',
    RAG_CRACK_RENDER_SCALE: 2.0,
  },
}))
vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/storage/client', () => ({ getObjectBuffer: vi.fn() }))

import { cropRect, redactUnlabelledNumbers } from '@/lib/rag/figure'

describe('cropRect', () => {
  const box = { xmin: 0.2, ymin: 0.3, xmax: 0.6, ymax: 0.5 }

  it('maps a normalised box onto pixels, padded outward', () => {
    // 0.4 wide and 0.2 tall, plus 0.01 of padding on each of the four sides.
    const rect = cropRect(box, 1000, 1000, 0.01)
    expect(rect.left).toBe(190)
    expect(rect.top).toBe(290)
    expect(rect.width).toBe(420)
    expect(rect.height).toBe(220)
  })

  it('clamps at the page edges rather than going negative', () => {
    const edge = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }
    const rect = cropRect(edge, 800, 600, 0.05)
    expect(rect).toEqual({ left: 0, top: 0, width: 800, height: 600 })
  })

  it('never returns a zero-width or zero-height crop', () => {
    // normalize.ts drops degenerate boxes, so this should be unreachable — but
    // a zero-sized canvas throws from inside the graphics library, which is a
    // much worse place to find out.
    const flat = { xmin: 0.5, ymin: 0.5, xmax: 0.5, ymax: 0.5 }
    const rect = cropRect(flat, 100, 100, 0)
    expect(rect.width).toBeGreaterThanOrEqual(1)
    expect(rect.height).toBeGreaterThanOrEqual(1)
  })

  it('pads, because axis labels sit outside the parser box', () => {
    const tight = cropRect(box, 1000, 1000, 0)
    const padded = cropRect(box, 1000, 1000, 0.02)
    expect(padded.left).toBeLessThan(tight.left)
    expect(padded.width).toBeGreaterThan(tight.width)
  })
})

describe('redactUnlabelledNumbers', () => {
  // What the parser extracted from the corpus's chart: quarter labels, and no
  // axis values at all.
  const CHART_LABELS = 'Q1\nQ2\nQ3\nQ4\nQ5'

  it('redacts the invented value the model actually returned', () => {
    // Measured 2026-09-10, unchanged across three prompt phrasings.
    const reading =
      'The tallest bar in the figure is Q3, and it reaches a value of approximately 90.'
    const { text, redacted } = redactUnlabelledNumbers(reading, CHART_LABELS)
    expect(redacted).toBe(1)
    expect(text).not.toContain('90')
    expect(text).toContain('[unlabelled]')
    // The relational half is correct and must survive.
    expect(text).toContain('Q3')
    expect(text).toContain('tallest')
  })

  it('swallows the hedge along with the number', () => {
    const { text } = redactUnlabelledNumbers('It is roughly 400.', CHART_LABELS)
    expect(text).toBe('It is [unlabelled].')
  })

  it('keeps a number that the figure actually prints', () => {
    const printed = 'Revenue\n0\n200\n400\nQ1 Q2 Q3'
    const reading = 'The axis runs from 0 to 400 and Q2 sits at 200.'
    const { text, redacted } = redactUnlabelledNumbers(reading, printed)
    expect(redacted).toBe(0)
    expect(text).toBe(reading)
  })

  it('keeps cross-references rather than redacting them', () => {
    const reading =
      'Figure 3.2 shows the trend; see section 4 and page 63 for detail.'
    const { text, redacted } = redactUnlabelledNumbers(reading, CHART_LABELS)
    expect(redacted).toBe(0)
    expect(text).toBe(reading)
  })

  it('matches a printed number regardless of thousands separators', () => {
    const { redacted } = redactUnlabelledNumbers(
      'The peak is 1,500 units.',
      'Peak 1500',
    )
    expect(redacted).toBe(0)
  })

  it('leaves a purely relational reading untouched', () => {
    // The case this tool is genuinely reliable for: the flowchart question was
    // answered correctly, and carries no numbers to redact.
    const reading =
      'After Triage, a scanned page goes to Parse image, and then to Normalise.'
    const { text, redacted } = redactUnlabelledNumbers(reading, 'Triage')
    expect(redacted).toBe(0)
    expect(text).toBe(reading)
  })

  it('redacts every unlabelled number, not just the first', () => {
    const { text, redacted } = redactUnlabelledNumbers(
      'Q1 is 215, Q2 is 308 and Q3 is 363.',
      CHART_LABELS,
    )
    expect(redacted).toBe(3)
    expect(text).not.toMatch(/\d{3}/)
  })

  it('handles a figure with no printed text at all', () => {
    const { text, redacted } = redactUnlabelledNumbers('It peaks at 90.', '')
    expect(redacted).toBe(1)
    expect(text).toContain('[unlabelled]')
  })
})
