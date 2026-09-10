import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import type { ChunkBox } from '@/db/schema'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { getObjectBuffer } from '@/lib/storage/client'
import { type ChatMessage, createChatCompletion } from './client'
import { renderPage, toDataUri } from './render'

/**
 * Reading a figure at ANSWER time (spec 0031 FR9).
 *
 * ## Why the pixels are not read at ingestion
 *
 * Measured 2026-09-10: asked to transcribe a bar chart blind, the vision model
 * returned 280 / 360 / 380 / 160 / 120 against ground truth 215 / 308 / 363 /
 * 138 / 92 — every value wrong by 15–30%, stated confidently, after being told
 * to say so rather than guess. It took 40s. Asked a SPECIFIC question about a
 * cropped region of a diagram, the same model answered correctly in 4.0s.
 *
 * A number transcribed at ingestion is a guess nobody asked for, it is
 * permanent, and `verify.ts` would confirm it as supported because the chunk
 * really does say it. A number read with the question in hand is evidence.
 * That is the whole reason this module exists at answer time and not in
 * `crack.ts`.
 *
 * ## Scoping
 *
 * This resolves a chunk BY ID and returns its pixels. That makes it the same
 * shape of hazard as `retrieveDocumentChunks` — read its comment. The
 * `owner_id` AND `knowledge_base_id` predicates below are the only things
 * standing between a model-supplied id and someone's document, and a
 * model-supplied id is exactly what this takes. Do not relax either one.
 */

/** The tool the planner may call. */
export const READ_FIGURE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_figure',
    description:
      'Look at a figure, chart or diagram from a document and read what it ' +
      'shows. Call this when a search result is a figure and answering needs ' +
      'a value, label or relationship from the image itself.',
    parameters: {
      type: 'object',
      properties: {
        chunkId: {
          type: 'string',
          description:
            'The id of the figure to look at, exactly as a search result gave it.',
        },
        question: {
          type: 'string',
          description:
            'What to look for in the figure. Be specific — "the Q2 value" ' +
            'reads better than "describe this".',
        },
      },
      required: ['chunkId', 'question'],
      additionalProperties: false,
    },
  },
}

const FIGURE_SYSTEM_PROMPT = `You are reading one figure from a document.

You will be told exactly which text is printed on the figure. That list is complete.

Rules:
- Answer from what is visible: shapes, positions, relationships, trends, and the printed text you were given.
- A number may ONLY be stated if it appears in that printed text. If it does not, the value is NOT LABELLED — say so, and answer in relative terms instead ("the tallest bar", "roughly twice Q4"). Never estimate a number from a bar height, a line position or an axis you cannot read.
- If the figure does not show what was asked, say so plainly.
- Be brief: two sentences at most.`

/** A figure chunk, resolved and permitted. */
export interface ResolvedFigure {
  chunkId: string
  documentId: string
  documentTitle: string
  pageNumber: number
  bbox: ChunkBox
  bucketKey: string
  /** The chunk's indexed text — its search key, not its content. */
  searchKey: string
}

interface FigureRow extends Record<string, unknown> {
  chunk_id: string
  document_id: string
  document_title: string
  page_number: number
  bbox: ChunkBox | null
  bucket_key: string
  content: string
}

/**
 * Resolve a figure the caller is actually allowed to see.
 *
 * Returns null for anything that is not a `figure` chunk with a box, inside
 * the caller's own knowledge bases. Null, never an error message that
 * distinguishes "no such chunk" from "not yours" — the same non-signal
 * `/api/documents/[id]/source` gives.
 */
export async function resolveFigure(
  ownerId: string,
  chunkId: string,
  knowledgeBaseIds: readonly string[],
): Promise<ResolvedFigure | null> {
  if (knowledgeBaseIds.length === 0) return null
  if (!chunkId || chunkId.length > 128) return null

  const kbArray = sql`ARRAY[${sql.join(
    knowledgeBaseIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`

  const rows = await db.execute<FigureRow>(sql`
    SELECT c.id          AS chunk_id,
           c.document_id AS document_id,
           d.title       AS document_title,
           c.page_number AS page_number,
           c.bbox        AS bbox,
           f.bucket_key  AS bucket_key,
           c.content     AS content
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN files f     ON f.id = d.file_id
    WHERE c.id = ${chunkId}
      AND c.owner_id = ${ownerId}
      AND c.knowledge_base_id = ANY(${kbArray})
      AND c.kind = 'figure'
    LIMIT 1
  `)

  const row = Array.from(rows)[0]
  if (!row?.bbox) return null

  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    pageNumber: Number(row.page_number),
    bbox: row.bbox,
    bucketKey: row.bucket_key,
    searchKey: row.content,
  }
}

/**
 * Pixel crop rectangle for a normalised box, padded and clamped.
 *
 * Padding is not cosmetic: measured on the eval corpus, a chart's axis labels
 * sit OUTSIDE the box the parser returns for it, so an unpadded crop hands the
 * model a picture of bars with no scale to read them against.
 *
 * Pure, so the arithmetic is testable without rendering anything.
 */
export function cropRect(
  bbox: ChunkBox,
  width: number,
  height: number,
  pad = 0.012,
): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.floor((bbox.xmin - pad) * width))
  const top = Math.max(0, Math.floor((bbox.ymin - pad) * height))
  const right = Math.min(width, Math.ceil((bbox.xmax + pad) * width))
  const bottom = Math.min(height, Math.ceil((bbox.ymax + pad) * height))
  return {
    left,
    top,
    // A degenerate box should never reach here (normalize.ts drops them), but
    // a zero-width crop would throw inside the canvas rather than fail here.
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  }
}

/** Cut a region out of a rendered page. */
export async function cropPng(png: Buffer, bbox: ChunkBox): Promise<Buffer> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const image = await loadImage(png)
  const rect = cropRect(bbox, image.width, image.height)
  const canvas = createCanvas(rect.width, rect.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(
    image,
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height,
  )
  return canvas.toBuffer('image/png')
}

/**
 * Remove numbers the figure does not actually print.
 *
 * **A prompt does not hold this line.** Measured 2026-09-10 against a chart
 * with no axis labels at all: asked for the tallest bar's value, the model
 * answered "approximately 90" against a true 363. Told to decline when a value
 * is unlabelled, it answered "approximately 90". Given the complete list of
 * text printed on the figure and told a number must appear in it, it answered
 * "approximately 90". Three phrasings, one answer.
 *
 * So the guard is deterministic instead, in the spirit of `verify.ts`: the
 * parser already extracted every string printed on the figure, which makes
 * "was this number written down?" a decidable question rather than a request.
 *
 * It redacts IN PLACE rather than dropping the sentence, because the relational
 * half is usually right and worth keeping — the same reading that invented 90
 * correctly identified Q3 as the tallest bar, and correctly traced a flowchart
 * elsewhere. What is unreliable is the quantity, not the observation.
 */
export function redactUnlabelledNumbers(
  reading: string,
  printedText: string,
): { text: string; redacted: number } {
  const printed = new Set(
    (printedText.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) =>
      n.replace(',', ''),
    ),
  )

  let redacted = 0
  const text = reading.replace(
    // A number, plus any hedge in front of it, so "approximately 90" does not
    // become "approximately an unlabelled value".
    /\b(?:(?:about|approximately|around|roughly|nearly|some)\s+)?(\d+(?:[.,]\d+)?)\b/gi,
    (match, number: string, offset: number) => {
      if (printed.has(number.replace(',', ''))) return match
      // A cross-reference ("figure 3.2", "page 7", "section 4") is naming
      // something, not reading a value off the image.
      const before = reading
        .slice(Math.max(0, offset - 12), offset)
        .toLowerCase()
      if (/(figure|fig\.|table|page|section|appendix|part)\s*$/.test(before)) {
        return match
      }
      redacted++
      // A visible marker, not fluent prose. "an unlabelled value" reads like
      // something the document said; "[unlabelled]" reads like a redaction,
      // which is what it is — and gives the answering model nothing to
      // paraphrase back into a number.
      return '[unlabelled]'
    },
  )

  return { text, redacted }
}

export interface FigureReading {
  text: string
  documentTitle: string
  pageNumber: number
  tokens: number
}

/**
 * Look at one figure and answer one question about it.
 *
 * Returns null when the figure cannot be resolved or read — the caller treats
 * that as "the tool found nothing", which is a normal outcome in a loop that
 * must be able to give up.
 */
export async function readFigure(
  {
    ownerId,
    chunkId,
    question,
    knowledgeBaseIds,
  }: {
    ownerId: string
    chunkId: string
    question: string
    knowledgeBaseIds: readonly string[]
  },
  { signal }: { signal?: AbortSignal } = {},
): Promise<FigureReading | null> {
  const figure = await resolveFigure(ownerId, chunkId, knowledgeBaseIds)
  if (!figure) return null

  try {
    const buffer = await getObjectBuffer(figure.bucketKey)
    const { getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const page = await renderPage(pdf, figure.pageNumber)
    const crop = await cropPng(page, figure.bbox)

    const messages: ChatMessage[] = [
      { role: 'system', content: FIGURE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            // The parser already extracted every string printed on this
            // figure. Handing that over as a CLOSED list is what turns "do not
            // invent a number" from a request into something checkable: any
            // figure not on the list is, by construction, not labelled.
            //
            // Measured 2026-09-10 without it: asked for the tallest bar's
            // value on a chart with no axis labels, the model answered
            // "approximately 90" against a true 363 — and did so after being
            // told to decline. A prompt alone did not hold.
            text:
              `Figure from "${figure.documentTitle}", page ${figure.pageNumber}.\n` +
              `Text printed on this figure (complete list): ${figure.searchKey.replace(/\s+/g, ' ').slice(0, 300) || '(none)'}\n\n` +
              `Question: ${question}`,
          },
          { type: 'image_url', image_url: { url: toDataUri(crop) } },
        ],
      },
    ]

    const { choice, tokens } = await createChatCompletion(messages, {
      model: env.RAG_VISION_MODEL,
      maxTokens: 300,
      signal,
    })

    const raw = choice.message?.content?.trim()
    if (!raw) return null

    const { text, redacted } = redactUnlabelledNumbers(raw, figure.searchKey)
    if (redacted > 0) {
      logger.info('Redacted unlabelled figure values', {
        chunkId,
        redacted,
      })
    }

    return {
      text,
      documentTitle: figure.documentTitle,
      pageNumber: figure.pageNumber,
      tokens,
    }
  } catch (error) {
    // A figure that cannot be read is not a failed answer — the loop carries
    // on with the text it already has.
    logger.warn('Reading a figure failed', {
      chunkId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
