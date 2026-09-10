import 'server-only'

import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { createChatCompletion } from './client'
import type { BBox, ParsedElement } from './parse-types'
import { renderPage, toDataUri } from './render'

/**
 * Layout parsing via `nvidia/nemotron-parse` (spec 0031 Stage 1).
 *
 * ## It answers with a tool call, not with prose
 *
 * The model does not return text. It returns a `tool_calls` entry named
 * `markdown_bbox` whose `arguments` are a JSON array of typed, boxed elements —
 * so `createChatCompletion` already has the machinery, because that is the same
 * shape the planner uses. Verified against the live endpoint 2026-09-10.
 *
 * The response is treated as untrusted input throughout: a parser that returns
 * something unexpected must degrade to "this page could not be cracked", never
 * throw halfway through a document. Every field is checked before it is
 * believed, and `normalize.ts` then repairs what is structurally wrong but
 * well-typed (inverted boxes, duplicates, response order).
 */

/** The function name the model calls back with. */
const PARSE_TOOL_NAME = 'markdown_bbox'

export class ParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ParseError'
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function toBBox(raw: unknown): BBox | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { xmin, ymin, xmax, ymax } = raw as Record<string, unknown>
  if (![xmin, ymin, xmax, ymax].every(isFiniteNumber)) return null
  return {
    xmin: xmin as number,
    ymin: ymin as number,
    xmax: xmax as number,
    ymax: ymax as number,
  }
}

/**
 * Pull elements out of whatever the model actually sent.
 *
 * Exported for testing: this is the part that has to survive the endpoint
 * changing its mind, and it can be exercised against recorded payloads with no
 * network. It is deliberately permissive about SHAPE (the arguments have been
 * observed wrapped in an outer array) and strict about CONTENT — an element
 * without a usable box or without text is dropped, not defaulted.
 */
export function elementsFromToolArguments(argumentsJson: string): {
  elements: ParsedElement[]
  dropped: number
} {
  let payload: unknown
  try {
    payload = JSON.parse(argumentsJson)
  } catch (error) {
    throw new ParseError('Parser returned arguments that are not JSON.', {
      cause: error,
    })
  }

  // Observed as `[[{...}, {...}]]` — one page's elements inside an outer array.
  // Unwrap at most one level rather than assuming either shape.
  const candidate = Array.isArray(payload) ? payload : [payload]
  const first = candidate[0]
  const list: unknown[] = Array.isArray(first) ? first : candidate

  const elements: ParsedElement[] = []
  let dropped = 0

  for (const item of list) {
    if (typeof item !== 'object' || item === null) {
      dropped++
      continue
    }
    const { type, text, bbox } = item as Record<string, unknown>
    const box = toBBox(bbox)
    if (typeof type !== 'string' || typeof text !== 'string' || !box) {
      dropped++
      continue
    }
    if (text.trim().length === 0) {
      dropped++
      continue
    }
    elements.push({ type, text, bbox: box })
  }

  return { elements, dropped }
}

export interface ParsePageResult {
  elements: ParsedElement[]
  tokens: number
  /** Elements the model returned that could not be believed. */
  dropped: number
}

/**
 * Render one page and parse it.
 *
 * Throws `ParseError` on anything that means "no usable elements for this
 * page". The caller (`ingest.ts`) decides what to do about it — retry at a
 * higher scale, fall back to the text layer, or record the page as unindexed —
 * because that decision is about the document's budget, not about this page.
 */
export async function parsePage(
  pdf: unknown,
  pageNumber: number,
  { scale, signal }: { scale?: number; signal?: AbortSignal } = {},
): Promise<ParsePageResult> {
  const png = await renderPage(pdf, pageNumber, scale ? { scale } : {})
  return parseRenderedPage(png, pageNumber, { signal })
}

/**
 * Parse a page that has ALREADY been rendered.
 *
 * Split out because a page carrying figures is needed twice — once to parse its
 * layout, once to crop each figure for description — and rendering is the
 * expensive local step. `crack.ts` renders once and calls this.
 */
export async function parseRenderedPage(
  png: Buffer,
  pageNumber: number,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ParsePageResult> {
  const { choice, tokens } = await createChatCompletion(
    [
      {
        role: 'user',
        // The image is the whole prompt. This model rejects plain string input
        // outright ("The model does not support text input"), so there is no
        // instruction to give it — asking for the parse IS sending the page.
        content: [{ type: 'image_url', image_url: { url: toDataUri(png) } }],
      },
    ],
    { model: env.RAG_PARSE_MODEL, maxTokens: 6000, signal },
  )

  const call = choice.message?.tool_calls?.find(
    (c) => c.function?.name === PARSE_TOOL_NAME,
  )
  const argumentsJson = call?.function?.arguments
  if (!argumentsJson) {
    throw new ParseError(
      `Parser returned no ${PARSE_TOOL_NAME} call for page ${pageNumber}.`,
    )
  }

  const { elements, dropped } = elementsFromToolArguments(argumentsJson)
  if (elements.length === 0) {
    throw new ParseError(`Parser found no elements on page ${pageNumber}.`)
  }

  if (dropped > 0) {
    logger.warn('Parser returned unusable elements', { pageNumber, dropped })
  }

  return { elements, tokens, dropped }
}
