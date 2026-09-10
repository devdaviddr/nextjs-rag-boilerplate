/**
 * The shape `nvidia/nemotron-parse` returns, and nothing more (spec 0031).
 *
 * Deliberately dependency-free and separate from the client that fetches it, so
 * `normalize.ts` can be unit-tested against recorded parser output with no
 * network and no API key. The fixtures in `tests/fixtures/parse/` are real
 * responses, defects included.
 */

/**
 * Element labels observed from the model on 2026-09-10.
 *
 * Kept as a union of known labels plus `string`, NOT a closed enum: the parser
 * is free to emit a label we have never seen, and an unknown label must degrade
 * to "treat it as body text" rather than throw away the content. `KNOWN_TYPES`
 * below is what the pipeline routes on; anything else falls through.
 */
export type ElementType =
  | 'Title'
  | 'Section-header'
  | 'Text'
  | 'Table'
  | 'Picture'
  | 'Caption'
  | 'Page-header'
  | 'Page-footer'
  | 'List-item'
  | 'Formula'
  | 'Footnote'
  | (string & {})

/** Normalised to the page: 0 is the left/top edge, 1 the right/bottom. */
export interface BBox {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

/** One element exactly as the parser returned it. */
export interface ParsedElement {
  type: ElementType
  text: string
  bbox: BBox
}

/** Elements that are page furniture, never document content (spec 0031 FR3). */
export const FURNITURE_TYPES = new Set<ElementType>([
  'Page-header',
  'Page-footer',
])

/** Elements that name the section their neighbours belong to. */
export const HEADING_TYPES = new Set<ElementType>(['Title', 'Section-header'])

/** Elements that are chunked whole rather than split to a token budget. */
export const ATOMIC_TYPES = new Set<ElementType>(['Table', 'Picture'])
