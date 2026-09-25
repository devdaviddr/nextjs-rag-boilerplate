import { and, asc, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/db'
import { chunks, documents } from '@/db/schema'
import { getCurrentSession } from '@/lib/auth/session'
import { type CitationLocation, toCitationBoxes } from '@/lib/citations/boxes'
import { parentRunBoxes } from '@/lib/rag/parents'

/**
 * Where on the page a citation came from (spec 0035 FR3–FR6).
 *
 * ## Why this is a lookup and not a field on the citation
 *
 * A citation is persisted as a `StoredCitation` inside `messages.citations`,
 * written at answer time. Every message answered before this spec ships is
 * already on disk without a box, and always will be — adding a field to
 * `StoredCitation` would give highlights to new answers only, and a reader
 * would have no way to tell "this chunk has no box" from "this conversation
 * is old". Resolving the box from `chunks` when the panel opens gives every
 * message, however old, the same behaviour.
 *
 * It also keeps the cost off the answer's path (NFR3): nothing here runs
 * until a reader actually clicks a citation.
 *
 * ## Scoping
 *
 * This resolves a chunk BY ID, which is the same shape of hazard as
 * `retrieveDocumentChunks` and `resolveFigure` — read their comments. The
 * `owner_id` predicate in the WHERE clause is the only thing standing between
 * a client-supplied id and someone else's document, and it is deliberately
 * part of the query rather than a check on the result.
 *
 * Owner is the right boundary here and knowledge base is not, which is the
 * opposite of `resolveFigure` and worth being explicit about. There the id
 * comes from the MODEL, mid-answer, inside a conversation scoped to some of a
 * user's knowledge bases. Here it comes from a citation in the user's own
 * transcript, and it resolves nothing the user could not already open for
 * themselves at `/api/documents/[id]/source`, which is owner-scoped too. Both
 * routes return the same 404 for "not yours" as for "no such thing", so
 * neither leaks existence.
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chunkId: string }> },
) {
  const session = await getCurrentSession()
  if (!session?.user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id
  const { chunkId } = await params

  // Bounded before it reaches the database, as `resolveFigure` does: an id
  // arriving from a client has no business being longer than a UUID.
  if (!chunkId || chunkId.length > 128) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const [row] = await db
    .select({
      documentId: chunks.documentId,
      pageNumber: chunks.pageNumber,
      pageCount: documents.pageCount,
      kind: chunks.kind,
      bbox: chunks.bbox,
      boxes: chunks.boxes,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(and(eq(chunks.id, chunkId), eq(chunks.ownerId, userId)))
    .limit(1)

  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // `bbox` is typed as a single box by the schema, but the column is `jsonb`
  // written by more than one ingestion path across more than one schema
  // version — a chunk spanning several elements stores a list (FR6). It is
  // handed over as `unknown` so the shape is decided by the one function
  // that knows all the shapes, not by a type assertion that would be wrong
  // silently.
  // The list wins; the legacy single rectangle is the fallback.
  let boxes = toCitationBoxes(row.boxes as unknown, row.bbox as unknown)

  // A section PARENT (spec 0033, 1c): highlight every chunk of the run this
  // chunk opens, not only the chunk itself. The page's rows are loaded under
  // the same owner predicate as the lookup above — the id came from a client
  // — and the run is found by the one shared `sectionRuns`, so the panel
  // highlights exactly what retrieval assembled. Runs never span a page, so
  // the page above stays exact (NFR3). Boxes are a list, never a union.
  if (new URL(request.url).searchParams.get('parent') === '1') {
    const pageRows = await db
      .select({
        id: chunks.id,
        kind: chunks.kind,
        heading: chunks.heading,
        headingBbox: chunks.headingBbox,
        chunkIndex: chunks.chunkIndex,
        boxes: chunks.boxes,
        bbox: chunks.bbox,
      })
      .from(chunks)
      .where(
        and(
          eq(chunks.documentId, row.documentId),
          eq(chunks.pageNumber, row.pageNumber),
          eq(chunks.ownerId, userId),
        ),
      )
      .orderBy(asc(chunks.chunkIndex))
    boxes = parentRunBoxes(pageRows, chunkId) ?? boxes
  }

  const location: CitationLocation = {
    documentId: row.documentId,
    pageNumber: row.pageNumber,
    pageCount: row.pageCount,
    kind: row.kind,
    boxes,
  }

  return NextResponse.json(location, {
    // A citation's location is as private as the document it points into.
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
