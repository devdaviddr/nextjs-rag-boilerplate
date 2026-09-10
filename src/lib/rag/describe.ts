import 'server-only'

import type { ChunkBox } from '@/db/schema'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { type ChatMessage, createChatCompletion } from './client'
import { cropPng, redactUnlabelledNumbers } from './figure'
import { toDataUri } from './render'

/**
 * Giving a caption-less figure something to be found BY (spec 0031 FR6, FR7).
 *
 * ## This is a search key, never evidence
 *
 * A captioned figure costs nothing: the caption is the document's own words and
 * says what the figure is about, which is exactly what a question matches
 * against. Only a figure with NO caption needs this, and what it needs is one
 * sentence naming the subject — not a transcription.
 *
 * The distinction is the whole spec. A description written at ingestion is
 * produced blind, with no question in hand, and measured 2026-09-10 that is
 * when the model is least reliable: asked to describe a bar chart cold it
 * returned five values, every one wrong by 15-30%, and took 40s. The same model
 * asked a specific question about the same chart at answer time was fast and
 * right about everything except the unlabelled quantities.
 *
 * So this asks for the SUBJECT, not the contents, and `redactUnlabelledNumbers`
 * removes any figure that slips through anyway. Reading the picture is
 * `read_figure`'s job, at answer time, with a question.
 */

const DESCRIBE_SYSTEM_PROMPT = `You write one-sentence search labels for figures in documents.

Your sentence is used to FIND the figure later. It is not a description of its contents and nobody will read it as one.

Say what the figure is: its type (bar chart, line graph, flow diagram, photograph, schematic), what it is about, and what its axes or labelled parts are called.
Do NOT state values, quantities or measurements. Do not describe the trend in numbers.
One sentence. No preamble.`

export interface DescribeResult {
  /** The search key. Never the figure's contents. */
  text: string
  tokens: number
}

/**
 * Describe one figure from an already-rendered page.
 *
 * Returns null on any failure — a figure without a description is still
 * indexed, just with only whatever stray text the parser scraped from inside
 * it. Degrading is always better than failing the document.
 */
export async function describeFigure(
  {
    png,
    bbox,
    documentTitle,
    heading,
    printedText,
  }: {
    png: Buffer
    bbox: ChunkBox
    documentTitle: string
    heading: string | null
    /** Text the parser found inside the figure. Grounds the redaction. */
    printedText: string
  },
  { signal }: { signal?: AbortSignal } = {},
): Promise<DescribeResult | null> {
  try {
    const crop = await cropPng(png, bbox)

    const context = [
      `Document: ${documentTitle.replace(/[-_]+/g, ' ')}`,
      heading ? `Section: ${heading}` : null,
      printedText.trim()
        ? `Text printed on the figure: ${printedText.replace(/\s+/g, ' ').slice(0, 200)}`
        : null,
    ]
      .filter(Boolean)
      .join('\n')

    const messages: ChatMessage[] = [
      { role: 'system', content: DESCRIBE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: context },
          { type: 'image_url', image_url: { url: toDataUri(crop) } },
        ],
      },
    ]

    const { choice, tokens } = await createChatCompletion(messages, {
      model: env.RAG_VISION_MODEL,
      // Short on purpose. A long budget invites the transcription this is
      // specifically not asking for.
      maxTokens: 120,
      signal,
    })

    const raw = choice.message?.content?.trim()
    if (!raw) return null

    // Same guard `read_figure` uses, for the same reason: the instruction not
    // to state values did not hold there and there is no reason to assume it
    // holds here. Deterministic, and it costs nothing.
    const { text, redacted } = redactUnlabelledNumbers(raw, printedText)
    if (redacted > 0) {
      logger.info('Redacted unlabelled values from a figure description', {
        redacted,
      })
    }

    return { text: text.slice(0, 400), tokens }
  } catch (error) {
    logger.warn('Describing a figure failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** Area of a normalised box as a share of the page. */
export function boxArea(bbox: ChunkBox): number {
  return Math.max(0, bbox.xmax - bbox.xmin) * Math.max(0, bbox.ymax - bbox.ymin)
}

/**
 * Is this `Picture` a figure, or decoration?
 *
 * A logo, a rule and a bullet glyph are all `Picture` elements. Describing one
 * spends the most expensive call in the system on furniture, and indexing one
 * puts a chunk in the knowledge base that can only ever be a false positive.
 */
export function isDescribableFigure(
  bbox: ChunkBox,
  minArea = env.RAG_CRACK_MIN_FIGURE_AREA,
): boolean {
  return boxArea(bbox) >= minArea
}
