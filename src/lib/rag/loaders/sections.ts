import type { ChunkKind } from '@/db/schema'
import { type Chunk, chunkElements } from '../chunk'
import type { DocumentChunks } from '../crack'
import { normalizePage } from '../normalize'
import type { ElementType, ParsedElement } from '../parse-types'

/** A text format's structure, before it is placed: `[type, text]` in order. */
export type SectionElements = { type: ElementType; text: string }[]

/**
 * Sections of elements to chunks (spec 0046), through the same normaliser and
 * chunker the PDF layout path uses. Each section becomes a numbered "page".
 *
 * The normaliser orders elements by their boxes, so each element is given a
 * box stacked in document order, which is the order it came in. Those boxes
 * describe nothing on a page and are stripped from the chunks afterwards, so
 * no citation ever tries to highlight them.
 */
export function sectionsToChunks(
  sections: readonly SectionElements[],
  options: { chunkTokens: number; overlapTokens: number },
): DocumentChunks {
  const chunks: Chunk[] = []
  const kept = sections.filter((s) => s.some((e) => e.text.trim()))
  for (const [index, section] of kept.entries()) {
    const n = section.length
    const placed: ParsedElement[] = section.map((element, i) => ({
      type: element.type,
      text: element.text,
      bbox: { xmin: 0, xmax: 1, ymin: i / n, ymax: (i + 1) / n },
    }))
    const pieces = chunkElements(normalizePage(placed), index + 1, {
      ...options,
      startIndex: chunks.length,
      textKind: 'text' as ChunkKind,
    })
    for (const piece of pieces) {
      const {
        bbox: _b,
        boxes: _bs,
        headingBox: _h,
        captionBox: _c,
        ...rest
      } = piece
      chunks.push(rest)
    }
  }
  return { chunks, pageCount: kept.length }
}

/** Heading levels that start a new section: `h1` to `h3` (spec 0046 FR3). */
export const SECTION_DEPTH = 3

/** Bytes as UTF-8 text, or null if they are not text. */
export function asText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  // Many replacement characters mean the bytes were not UTF-8 text.
  const bad = text.match(/�/g)?.length ?? 0
  return bad > text.length / 100 ? null : text.replace(/^﻿/, '')
}
