import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/db'
import { documents, files } from '@/db/schema'
import { getCurrentSession } from '@/lib/auth/session'
import { logger } from '@/lib/logger'
import { renderPage } from '@/lib/rag/render'
import { rateLimit } from '@/lib/rate-limit'
import { getObjectBuffer } from '@/lib/storage/client'

/**
 * Renders ONE page of a document to a PNG, so the citation panel can draw the
 * cited region on top of it (spec 0035 FR3).
 *
 * ## Why this route exists at all — the security decision spec 0035 demanded
 *
 * A native PDF viewer in an iframe takes `#page=N` and nothing else; there is
 * no way to draw a rectangle on it. Spec 0035 named two ways out and chose the
 * first: render with pdf.js in the citation panel, or serve documents from a
 * separate origin and keep the native viewer (which cannot highlight, so it
 * defeats the spec). This route is a THIRD option the spec did not consider,
 * and it is chosen here over pdf.js-in-the-browser for reasons that are worth
 * writing down, because the obvious reading of the spec is that this file
 * should not exist.
 *
 * Rendering with pdf.js in the panel moves an untrusted, attacker-supplied PDF
 * into the JavaScript context of the authenticated application origin. That is
 * a NEW trust boundary: CVE-2024-4367 was exactly this — a crafted font in a
 * PDF executing arbitrary JavaScript in the page embedding pdf.js — and the
 * embedding page here holds the user's session.
 *
 * Rendering server-side adds no trust boundary whatsoever. This application
 * ALREADY parses every one of these PDFs with pdf.js in this same Node
 * process, at ingestion: `extract.ts` opens each upload with `getDocumentProxy`
 * and `render.ts` rasterises its pages for the parser. A PDF that could
 * compromise pdf.js has had that opportunity before it was ever cited. What
 * reaches the browser from here is an `image/png` with `nosniff`, which cannot
 * become script under any interpretation.
 *
 * Two smaller properties fall out of the same choice and both matter:
 *
 * - **The coordinates need no re-derivation.** `chunks.bbox` is normalised
 *   0–1 top-left *in the frame of the page image `render.ts` produced*, which
 *   is what the layout parser was looking at when it drew the box. Rendering
 *   the page the same way and positioning rectangles as percentages of the
 *   image reproduces that frame exactly. Highlighting on a pdf.js canvas would
 *   mean re-deriving the mapping through the viewport, page rotation and a
 *   possibly non-zero CropBox origin — three chances to place a box
 *   confidently in the wrong place, which spec 0035 identifies as strictly
 *   worse than placing no box at all.
 * - **The app's CSP needs no relaxing.** `img-src 'self'` already covers this;
 *   pdf.js wants a worker, and `worker-src 'self'` does not permit the blob
 *   worker it constructs.
 *
 * The cost of this choice is honest and is not zero: the panel shows a picture
 * of a page, so text in it cannot be selected, searched or copied. The
 * document itself is one click away in the panel's "Open in new tab", which
 * still serves `/api/documents/[id]/source` to the browser's own viewer,
 * unchanged. That route and its hardening headers are untouched by this spec
 * (NFR1).
 *
 * ## Hardening
 *
 * The same reasoning as `../source/route.ts`, minus the parts that only a
 * framed active format needs:
 *
 * - Ownership is in the WHERE clause, and someone else's document returns the
 *   same 404 as one that does not exist.
 * - `Content-Type` is pinned to `image/png` — the bytes are produced by this
 *   process, never echoed from the stored object — with `nosniff` beside it.
 * - `Cache-Control: private, no-store` keeps page images off shared disks,
 *   matching what the source route does for the document itself.
 * - No `X-Frame-Options` exemption is needed or wanted: this is an `<img>`,
 *   not a frame, so the global `DENY` from `next.config.ts` applies and is
 *   correct.
 * - Rate limited per user. Unlike streaming stored bytes, this spends CPU and
 *   memory per request — one careless loop in a client should not be able to
 *   rasterise a document a thousand times.
 */

/**
 * Requests per user per window.
 *
 * Generous enough to page through a long document by hand and nowhere near
 * enough to be a CPU amplifier. Kept local rather than added to
 * `rate-limit.ts`'s shared tables because it limits a rendering cost, not an
 * auth, upload or inference budget.
 */
const PAGE_RENDER_LIMIT = { limit: 120, windowMs: 10 * 60_000 }

/**
 * Render scale.
 *
 * Purely a sharpness-versus-bytes knob: the boxes are normalised, so nothing
 * about the highlight's accuracy depends on this. 2 matches the scale spec
 * 0031 renders at for the parser, which means a highlight that ever does land
 * wrong can be reproduced against exactly the image the parser saw.
 */
const PAGE_RENDER_SCALE = 2

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getCurrentSession()
  if (!session?.user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id
  const { id } = await params

  const limit = rateLimit(
    `page-render:${userId}`,
    PAGE_RENDER_LIMIT.limit,
    PAGE_RENDER_LIMIT.windowMs,
  )
  if (!limit.success) {
    return NextResponse.json(
      { error: 'Too many page renders. Try again shortly.' },
      { status: 429 },
    )
  }

  const requested = Number(new URL(request.url).searchParams.get('n'))
  if (!Number.isInteger(requested) || requested < 1) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const [row] = await db
    .select({ bucketKey: files.bucketKey, mimeType: files.mimeType })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(and(eq(documents.id, id), eq(documents.ownerId, userId)))
    .limit(1)

  if (!row || row.mimeType !== 'application/pdf') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const buffer = await getObjectBuffer(row.bucketKey)
    // Lazily imported for the same reason `extract.ts` does it: the PDF
    // machinery should not be pulled into every route that shares a module
    // with this one.
    const { getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(buffer))

    // Checked against the document itself rather than `documents.pageCount`,
    // which is nullable for anything ingested before it was recorded. An
    // out-of-range page is a 404, never a render attempt.
    if (requested > pdf.numPages) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const png = await renderPage(pdf, requested, { scale: PAGE_RENDER_SCALE })

    return new NextResponse(new Uint8Array(png), {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(png.byteLength),
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    // A page that will not render is not an error the reader can act on, and
    // the panel already falls back to the browser's own viewer when this
    // request fails. Logged for the operator, opaque to the client — the same
    // non-signal every other lookup on this document gives.
    logger.warn('Could not render a document page', {
      userId,
      documentId: id,
      pageNumber: requested,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
