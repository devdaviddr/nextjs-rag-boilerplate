import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/db'
import { documents, files } from '@/db/schema'
import { getCurrentSession } from '@/lib/auth/session'
import { getObjectStream } from '@/lib/storage/client'

/**
 * Streams a document's PDF **inline**, so a citation can open it in place
 * (spec 0026 FR13).
 *
 * This is a separate route from `/api/files/[id]`, which serves
 * `Content-Disposition: attachment` and stays that way. Serving a
 * user-uploaded PDF inline changes the threat model — a PDF is an active
 * format and the browser's viewer will run its scripting — so this response is
 * hardened rather than the existing download route being relaxed:
 *
 * - `X-Content-Type-Options: nosniff` plus a content type pinned to
 *   `application/pdf` (rather than echoed from the stored object) means the
 *   browser can never re-interpret a crafted upload as HTML and run it as
 *   script on our origin. That is the attack that matters here, and these two
 *   headers close it.
 * - `Cache-Control: private, no-store` keeps documents off shared disks.
 *
 * A `Content-Security-Policy: sandbox` header was tried and REMOVED: it forces
 * an opaque origin, which stops the browser's PDF viewer initialising at all —
 * the panel renders a broken-document icon instead of the document. The
 * "fix" of `sandbox allow-scripts allow-same-origin` is not a fix, because
 * that combination lets the content drop its own sandbox; it would have been
 * security theatre that also happened to work.
 *
 * Residual risk, named rather than hidden: the PDF is rendered by the
 * browser's own viewer, which executes PDF JavaScript in its own process with
 * no access to this page's DOM or cookies. Eliminating even that means either
 * serving documents from a separate origin, or rendering with pdf.js — which
 * is the upgrade path recorded in spec 0026.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getCurrentSession()
  if (!session?.user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id
  const { id } = await params

  // Ownership is in the WHERE clause, and a document belonging to someone else
  // returns the same 404 as one that does not exist — no existence signal.
  const [row] = await db
    .select({ bucketKey: files.bucketKey, mimeType: files.mimeType })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(and(eq(documents.id, id), eq(documents.ownerId, userId)))
    .limit(1)

  if (!row || row.mimeType !== 'application/pdf') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { body, contentLength } = await getObjectStream(row.bucketKey)

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/pdf',
      ...(contentLength ? { 'Content-Length': String(contentLength) } : {}),
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      // Framable by this app only. The global header is DENY, which blocks
      // even same-origin framing; these two narrow it to `self` for this one
      // response. `frame-ancestors` is the modern directive and the one
      // browsers honour when both are present.
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'",
      'Cache-Control': 'private, no-store',
    },
  })
}
