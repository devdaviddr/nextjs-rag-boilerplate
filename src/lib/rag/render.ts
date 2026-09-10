import 'server-only'

import { env } from '@/lib/env'

/**
 * Rendering one PDF page to an image for the parser (spec 0031 Stage 1).
 *
 * In-process via `unpdf`'s `renderPageAsImage`, which needs a canvas
 * implementation — `@napi-rs/canvas`, the only dependency this whole spec adds.
 * Still no sidecar container, which is the property that made `nemotron-parse`
 * preferable to a Python parsing service in the first place.
 */

/**
 * PNG, always. Not a preference — a measurement.
 *
 * A JPEG of an identical page scored **0.098** cosine self-similarity against
 * its PNG when embedded, where two PNG renders of the same page at different
 * resolutions scored **0.944** (2026-09-10). Something in the chain mishandles
 * JPEG and reports nothing, so the format is pinned here rather than left to a
 * caller who has no way of knowing.
 */
export const RENDER_MIME_TYPE = 'image/png'

export class RenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RenderError'
  }
}

/**
 * Render `pageNumber` (1-based) of an already-open PDF proxy.
 *
 * Takes the proxy rather than a buffer so a document being cracked page by
 * page is parsed once, not once per page.
 */
export async function renderPage(
  pdf: unknown,
  pageNumber: number,
  { scale = env.RAG_CRACK_RENDER_SCALE }: { scale?: number } = {},
): Promise<Buffer> {
  // Lazily imported for the same reason `extract.ts` does it: keeping the PDF
  // machinery out of every route that happens to touch this module's siblings.
  const { renderPageAsImage } = await import('unpdf')

  try {
    const image = await renderPageAsImage(
      pdf as Parameters<typeof renderPageAsImage>[0],
      pageNumber,
      {
        scale,
        canvasImport: () =>
          import('@napi-rs/canvas') as unknown as Promise<
            typeof import('@napi-rs/canvas')
          >,
      },
    )
    return Buffer.from(image)
  } catch (error) {
    throw new RenderError(`Could not render page ${pageNumber} of this PDF.`, {
      cause: error,
    })
  }
}

/** The `data:` URI form the inference endpoint expects for an image part. */
export function toDataUri(png: Buffer): string {
  return `data:${RENDER_MIME_TYPE};base64,${png.toString('base64')}`
}
