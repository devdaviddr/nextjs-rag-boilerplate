import 'server-only'

import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'

import { db } from '@/db'
import {
  chunks as chunksTable,
  documents,
  files,
  parsedPages,
} from '@/db/schema'
import type { DocumentStatus, ExtractionSummary } from '@/db/schema'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { getObjectBuffer } from '@/lib/storage/client'
import { buildEmbeddingText } from './chunk'
import { type ParsedPageCache, chunksFromPdf } from './crack'
import { embedPassages } from './embed'
import { ExtractionError } from './extract'
import type { ParsedElement } from './parse-types'

/**
 * The ingestion state machine (spec 0025 FR4).
 *
 *   pending -> extracting -> embedding -> ready
 *                        \-> failed (with a user-readable reason)
 *
 * Runs out-of-band from the request that triggered it: a 200-page PDF is
 * hundreds of embedding calls against a rate-limited endpoint, which cannot
 * happen inside a Server Action. No queue and no worker container — the
 * boilerplate's deliberate "no queue" stance from spec 0007 still holds, and
 * `documents.status` is what the UI polls.
 *
 * ## Why there is a claim protocol (spec 0034)
 *
 * That stance rested on ingestion taking seconds. Cracking (spec 0031) made an
 * 8-page PDF take 51 seconds and a 25-page one minutes, and this project's
 * deploy model is a pull timer that restarts the container. A restart landing
 * mid-run used to leave a document in `extracting` forever: nothing retried it,
 * the UI polled a status that would never change, and the only escape was
 * delete-and-re-upload.
 *
 * So a run now **claims** its document — `claimed_at` stamped by a conditional
 * update, refreshed on every page it finishes — and `recoverStrandedDocuments`
 * sweeps for transient-status rows whose claim went stale. Postgres's own row
 * locking serialises two conditional updates, so the claim gives mutual
 * exclusion with no broker and no new service.
 *
 * ## The claim is a lease, not a lock
 *
 * A worker that hangs longer than `INGEST_CLAIM_WINDOW_MS` inside one page has
 * its document claimed by another, and both may reach the end. Two things keep
 * that safe, in that order:
 *
 * 1. The chunk write is a single delete-then-insert transaction (0025 NFR5), so
 *    whichever commits second wins whole and neither leaves duplicates. This is
 *    the guarantee; it does not depend on the fencing below.
 * 2. Every write this module makes to `documents` after the claim is fenced on
 *    `claimed_at` still equalling the token it claimed with. A worker whose
 *    lease was stolen discovers it at its next page and stops, instead of
 *    spending another twenty parse calls and then overwriting a good `ready`
 *    with its own stale `failed`.
 *
 * The resume path (`parsedPages`) deliberately writes **outside** the chunk
 * transaction and never inside it, so it cannot weaken (1).
 */

/**
 * How long a claim stands without being refreshed before another worker may
 * take the document.
 *
 * A live run touches `claimed_at` after every page, so this only has to cover
 * the slowest single page — a parse plus up to `RAG_DESCRIBE_MAX_FIGURES`
 * vision calls, each measured at ~40s in spec 0031. Ten minutes is comfortably
 * past that, and is the ceiling on how long a stranded document stays invisible
 * to the sweep.
 */
export const INGEST_CLAIM_WINDOW_MS = 10 * 60_000

/**
 * How many times ingestion may be *started* for a document before recovery
 * gives up on it (FR2).
 *
 * This bounds the one failure the try/catch cannot: a document whose parsing
 * kills the process. There is no catch block on that path, so the row stays
 * transient and the sweep would otherwise pick it up forever — a file that
 * reliably crashes the parser becomes an unbounded drain on a shared rate
 * limit. Ordinary failures never reach here; they land in `failed` with a
 * reason on the first attempt and the sweep does not look at `failed`.
 */
export const MAX_INGEST_ATTEMPTS = 3

/** Documents one sweep will look at. Bounds the query, not the concurrency. */
export const RECOVERY_BATCH_SIZE = 10

/**
 * Recovery runs at a time (NFR2). Deliberately tiny: fifty documents stranded
 * by one restart must not become fifty concurrent cracking runs against a
 * rate-limited endpoint. They drain a couple at a time over successive sweeps,
 * which is slower and is the point.
 */
export const RECOVERY_CONCURRENCY = 2

/** How often the background sweep runs once `startIngestionRecovery` is on. */
export const RECOVERY_INTERVAL_MS = 60_000

/**
 * Grace before an unclaimed transient row is considered stranded.
 *
 * A freshly inserted `pending` document has no claim for the moment between
 * the INSERT and `after()` running its worker. Without this the sweep would
 * race every upload — harmlessly, because the claim would still elect one
 * winner, but it would also make "stuck" and "just started" indistinguishable,
 * which NFR3 asks us not to do.
 */
export const STRANDED_GRACE_MS = 60_000

/** Statuses that mean "work is supposed to be happening on this row". */
const TRANSIENT_STATUSES: DocumentStatus[] = [
  'pending',
  'extracting',
  'embedding',
]

/** Thrown when this worker's lease was taken while it was still running. */
class ClaimLostError extends Error {
  constructor() {
    super('Another worker took over this document.')
    this.name = 'ClaimLostError'
  }
}

/** What a worker holds while it owns a document: the exact `claimed_at` value. */
type ClaimToken = Date

/**
 * Take a document, or find out that someone else has it.
 *
 * The whole of FR4 is the `WHERE` clause. Two workers issuing this update at
 * once are serialised by Postgres on the row: the first sets `claimed_at`, the
 * second re-evaluates its predicate against the *new* row, no longer matches,
 * and updates nothing. No advisory lock, no `SELECT ... FOR UPDATE`, no broker.
 *
 * `claimed_at` is set from a JS `Date`, not `now()`, on purpose. It doubles as
 * the fencing token every later write compares against, and Postgres stores
 * microseconds while a JS `Date` carries milliseconds — a token read back from
 * `now()` would be truncated on the way out and never match on the way in.
 */
async function claimDocument(
  documentId: string,
  trigger: IngestTrigger,
): Promise<
  | { ok: true; token: ClaimToken; doc: typeof documents.$inferSelect }
  | { ok: false; reason: 'held' | 'exhausted' | 'missing' }
> {
  const token = new Date()
  const expiredBefore = new Date(token.getTime() - INGEST_CLAIM_WINDOW_MS)

  const [row] = await db
    .update(documents)
    .set({
      claimedAt: token,
      // A user pressing Retry, or a fresh upload, is not an automatic retry —
      // it restarts the budget rather than spending from it. Only the sweep is
      // bounded by MAX_INGEST_ATTEMPTS, because only the sweep can loop.
      attempts: trigger === 'recovery' ? sql`${documents.attempts} + 1` : 1,
      status: 'extracting',
      error: null,
    })
    .where(
      and(
        eq(documents.id, documentId),
        or(isNull(documents.claimedAt), lt(documents.claimedAt, expiredBefore)),
        ...(trigger === 'recovery'
          ? [lt(documents.attempts, MAX_INGEST_ATTEMPTS)]
          : []),
      ),
    )
    .returning()

  if (row) return { ok: true, token, doc: row }

  // Nothing updated: work out which of the three reasons it was, so the caller
  // can log something a human can act on.
  const current = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
    columns: { attempts: true },
  })
  if (!current) return { ok: false, reason: 'missing' }
  return {
    ok: false,
    reason:
      trigger === 'recovery' && current.attempts >= MAX_INGEST_ATTEMPTS
        ? 'exhausted'
        : 'held',
  }
}

/**
 * Finish a document, but only if this worker still owns it.
 *
 * The `claimed_at` predicate is the fence. Without it, a worker that lost its
 * lease and failed ten minutes later would stamp `failed` over the `ready` its
 * replacement had already written, and the user would be told a document that
 * is sitting in their knowledge base, fully indexed, could not be processed.
 *
 * Returns whether the write landed.
 */
async function finishDocument(
  documentId: string,
  token: ClaimToken,
  status: Extract<DocumentStatus, 'ready' | 'failed'>,
  extra: {
    error?: string | null
    pageCount?: number
    pagesProcessed?: number
    extraction?: ExtractionSummary
  } = {},
): Promise<boolean> {
  const [row] = await db
    .update(documents)
    .set({
      status,
      error: extra.error ?? null,
      // The claim is released here and nowhere else. Anything that leaves it
      // set on a terminal row makes that row invisible to the sweep for a
      // window, which is only ever wrong.
      claimedAt: null,
      // A document that made it through has no retry history worth keeping;
      // leaving the count high would make its next user-initiated retry look
      // like a crash loop to the sweep.
      ...(status === 'ready' ? { attempts: 0 } : {}),
      ...(extra.pageCount !== undefined ? { pageCount: extra.pageCount } : {}),
      ...(extra.pagesProcessed !== undefined
        ? { pagesProcessed: extra.pagesProcessed }
        : {}),
      ...(extra.extraction !== undefined
        ? { extraction: extra.extraction }
        : {}),
    })
    .where(and(eq(documents.id, documentId), eq(documents.claimedAt, token)))
    .returning({ id: documents.id })

  return row !== undefined
}

/**
 * A unit of work finished: renew the lease, and record whatever it produced.
 *
 * Folding the heartbeat into the writes the pipeline was already making is
 * what turns `INGEST_CLAIM_WINDOW_MS` into "no live worker" rather than
 * "started more than ten minutes ago". Crucially the renewal is driven by work
 * *completing*, not by a timer — a timer would keep renewing the claim of a run
 * wedged on a socket that will never answer, which is precisely the run the
 * sweep needs to be able to take over.
 *
 * Progress is deliberately not routed through the status writers, which clear
 * `error` on every write and would erase a failure mid-run (0031 FR13).
 *
 * Throws `ClaimLostError` if the lease is gone, which stops this run rather
 * than letting it keep spending against a document someone else now owns.
 */
async function renewClaim(
  documentId: string,
  token: ClaimToken,
  progress: {
    status?: Extract<DocumentStatus, 'extracting' | 'embedding'>
    pageCount?: number
    pagesProcessed?: number
    extraction?: ExtractionSummary
  } = {},
): Promise<ClaimToken> {
  const next = new Date()
  const [row] = await db
    .update(documents)
    .set({
      claimedAt: next,
      ...(progress.status !== undefined ? { status: progress.status } : {}),
      ...(progress.pageCount !== undefined
        ? { pageCount: progress.pageCount }
        : {}),
      ...(progress.pagesProcessed !== undefined
        ? { pagesProcessed: progress.pagesProcessed }
        : {}),
      ...(progress.extraction !== undefined
        ? { extraction: progress.extraction }
        : {}),
    })
    .where(and(eq(documents.id, documentId), eq(documents.claimedAt, token)))
    .returning({ id: documents.id })

  if (!row) throw new ClaimLostError()
  return next
}

/**
 * Chunks embedded per lease renewal.
 *
 * `embedPassages` batches and pools internally, so this only decides how often
 * the run gets to prove it is alive. Without it, embedding a 200-page document
 * is one uninterrupted await against a rate-limited endpoint — easily longer
 * than the claim window, at which point the sweep would hand a perfectly
 * healthy run's document to a second worker. 128 is four of the default
 * 32-text batches, so the pool still saturates.
 */
const EMBED_HEARTBEAT_CHUNKS = 128

/**
 * The Postgres-backed `ParsedPageCache` (FR3).
 *
 * Keyed by file, not document: parser output is a pure function of the page
 * image and the uploaded bytes never change, so an entry cannot be wrong for
 * its key. That is why there is no invalidation here beyond the render scale,
 * which is part of the key because it changes the input.
 *
 * Writes are per page and outside every transaction, which is the property
 * that makes them survive the process dying — and equally the property that
 * keeps them out of the chunk transaction's way.
 */
function parsedPageCache(fileId: string): ParsedPageCache {
  const renderScale = env.RAG_CRACK_RENDER_SCALE
  return {
    async get(page) {
      const row = await db.query.parsedPages.findFirst({
        where: and(
          eq(parsedPages.fileId, fileId),
          eq(parsedPages.page, page),
          eq(parsedPages.renderScale, renderScale),
        ),
        columns: { elements: true },
      })
      return (row?.elements as ParsedElement[] | undefined) ?? null
    },
    async set(page, elements) {
      await db
        .insert(parsedPages)
        .values({ fileId, page, renderScale, elements: [...elements] })
        .onConflictDoUpdate({
          target: [parsedPages.fileId, parsedPages.page],
          set: { renderScale, elements: [...elements], createdAt: new Date() },
        })
    },
  }
}

/** Why this run was started. Only `recovery` is bounded by the attempt cap. */
export type IngestTrigger = 'request' | 'recovery'

export async function ingestDocument(
  documentId: string,
  options: { trigger?: IngestTrigger } = {},
): Promise<void> {
  const trigger = options.trigger ?? 'request'

  const claim = await claimDocument(documentId, trigger)
  if (!claim.ok) {
    // None of these are errors. A document is missing because it was deleted
    // while queued; held because another worker has it (exactly what FR4 asks
    // for); exhausted because the sweep has already given up on it and marked
    // it failed.
    logger.info('Ingestion skipped', {
      documentId,
      trigger,
      reason: claim.reason,
    })
    return
  }

  const { doc } = claim
  let token = claim.token

  try {
    const file = await db.query.files.findFirst({
      where: eq(files.id, doc.fileId),
      columns: { bucketKey: true },
    })
    if (!file)
      throw new ExtractionError('The uploaded file is no longer available.')

    const buffer = await getObjectBuffer(file.bucketKey)
    const {
      chunks: pieces,
      pageCount,
      extraction,
    } = await chunksFromPdf(buffer, {
      chunkTokens: env.RAG_CHUNK_TOKENS,
      overlapTokens: env.RAG_CHUNK_OVERLAP_TOKENS,
      documentTitle: doc.title,
      // A resumed run re-walks every page and re-derives every chunk; what it
      // does not re-pay for is the parse call on pages this or an earlier
      // attempt already bought. Chunking and embedding are cheap and, crucially,
      // still produce the whole document in memory — so the one transaction
      // below stays exactly as wide as it was.
      parseCache: parsedPageCache(doc.fileId),
      onPageProcessed: async (processed, summarySoFar) => {
        token = await renewClaim(documentId, token, {
          pagesProcessed: processed,
          extraction: summarySoFar,
        })
      },
    })

    if (pieces.length === 0) {
      throw new ExtractionError(
        'No readable text could be extracted from this PDF.',
      )
    }

    token = await renewClaim(documentId, token, {
      status: 'embedding',
      pageCount,
      ...(extraction !== undefined ? { extraction } : {}),
    })

    // Embed the composed text (title + heading + content), store the original.
    // A citation must show the document's own words, not this preamble.
    const texts = pieces.map((piece) =>
      buildEmbeddingText({
        documentTitle: doc.title,
        heading: piece.heading,
        caption: piece.caption,
        content: piece.content,
      }),
    )

    const vectors: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_HEARTBEAT_CHUNKS) {
      vectors.push(
        ...(await embedPassages(texts.slice(i, i + EMBED_HEARTBEAT_CHUNKS))),
      )
      token = await renewClaim(documentId, token)
    }

    // Delete-then-insert inside one transaction makes re-ingesting a failed
    // document idempotent — a retry can never double up chunks (NFR5). This is
    // also what makes the claim window safe to be a lease rather than a lock:
    // two workers that both finish this document both run this, and the second
    // commit replaces the first's rows wholesale. Nothing about resuming may
    // narrow this boundary to a page, or that stops being true.
    await db.transaction(async (tx) => {
      await tx.delete(chunksTable).where(eq(chunksTable.documentId, documentId))
      await tx.insert(chunksTable).values(
        pieces.map((piece, i) => ({
          documentId,
          ownerId: doc.ownerId,
          // Denormalised from the document, never from the session: a chunk's
          // KB must always be its document's KB, or retrieval filters on a
          // value the document itself disagrees with. Recovery runs as the
          // system with no session at all, so this is the only correct source.
          knowledgeBaseId: doc.knowledgeBaseId,
          content: piece.content,
          heading: piece.heading,
          pageNumber: piece.pageNumber,
          chunkIndex: piece.chunkIndex,
          tokenCount: piece.tokenCount,
          // 'text' when the text-layer path produced this chunk, which is
          // also the column default — so nothing about an uncracked document
          // changes shape.
          kind: piece.kind ?? 'text',
          bbox: piece.bbox ?? null,
          embedding: vectors[i] as number[],
        })),
      )
    })

    const landed = await finishDocument(documentId, token, 'ready', {
      pageCount,
      pagesProcessed: pageCount,
      ...(extraction !== undefined ? { extraction } : {}),
    })

    // The chunks are written either way — that transaction is unconditional and
    // idempotent. Only the status write is fenced, so losing the race here
    // means the winner already reported `ready` and there is nothing to fix.
    if (landed) await dropParseCache(doc.fileId)

    logger.info('Document ingested', {
      documentId,
      trigger,
      attempts: doc.attempts + (trigger === 'recovery' ? 1 : 0),
      pageCount,
      chunkCount: pieces.length,
      parseCalls: extraction?.parseCalls ?? 0,
      cachedPages: extraction?.cachedPages ?? 0,
      budgetExhausted: extraction?.budgetExhausted ?? false,
      claimHeld: landed,
    })
  } catch (error) {
    if (error instanceof ClaimLostError) {
      // Not a failure of this document, only of this run. Say nothing about
      // `status` — the worker that owns it now is mid-flight.
      logger.warn('Ingestion abandoned — claim lost', { documentId, trigger })
      return
    }

    // ExtractionError messages are written for the user and are safe to show.
    // Anything else could carry internals, so it is logged and generalised.
    const isExpected = error instanceof ExtractionError
    const message = isExpected
      ? error.message
      : 'Processing failed. Please try again, or remove and re-upload this document.'

    if (!isExpected) {
      logger.error('Document ingestion failed', {
        documentId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // The parse cache is deliberately kept on failure: it is what makes the
    // user's next Retry cheap, which is the second cost spec 0034 set out to
    // remove. It goes when the file goes, by cascade.
    await finishDocument(documentId, token, 'failed', { error: message })
  }
}

/**
 * Drop a file's cached parser output once its document is `ready`.
 *
 * The chunks are the durable artefact from that point; the cache is bulk that
 * would otherwise sit in Postgres for the life of the upload. Best-effort —
 * failing to tidy up must not fail a document that has already succeeded.
 */
async function dropParseCache(fileId: string): Promise<void> {
  try {
    await db.delete(parsedPages).where(eq(parsedPages.fileId, fileId))
  } catch (error) {
    logger.warn('Parse cache cleanup failed', {
      fileId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Run `task` over `items`, never more than `limit` at once. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (let i = cursor++; i < items.length; i = cursor++) {
        const item = items[i]
        if (item === undefined) return
        await task(item)
      }
    },
  )
  await Promise.all(runners)
}

/**
 * Find documents nothing is working on any more, and work on them (FR1).
 *
 * The predicate is the whole definition of "stranded": a transient status, a
 * claim that is absent or older than the window, and a row untouched for the
 * grace period. A live run fails all three — it heartbeats every page — so this
 * cannot steal work from a healthy worker, only from a dead one.
 *
 * Ordered oldest-first so a document that has been stuck longest is recovered
 * first, and capped by both `limit` and `RECOVERY_CONCURRENCY` so a restart
 * with fifty stranded documents drains steadily instead of arriving at the
 * parse endpoint all at once (NFR2).
 */
export async function recoverStrandedDocuments(
  options: { limit?: number; concurrency?: number } = {},
): Promise<{ resumed: number; abandoned: number }> {
  const limit = options.limit ?? RECOVERY_BATCH_SIZE
  const concurrency = options.concurrency ?? RECOVERY_CONCURRENCY
  const now = Date.now()

  const stranded = await db
    .select({
      id: documents.id,
      attempts: documents.attempts,
    })
    .from(documents)
    .where(
      and(
        inArray(documents.status, TRANSIENT_STATUSES),
        or(
          isNull(documents.claimedAt),
          lt(documents.claimedAt, new Date(now - INGEST_CLAIM_WINDOW_MS)),
        ),
        lt(documents.updatedAt, new Date(now - STRANDED_GRACE_MS)),
      ),
    )
    .orderBy(asc(documents.updatedAt))
    .limit(limit)

  if (stranded.length === 0) return { resumed: 0, abandoned: 0 }

  const exhausted = stranded.filter((d) => d.attempts >= MAX_INGEST_ATTEMPTS)
  const retryable = stranded.filter((d) => d.attempts < MAX_INGEST_ATTEMPTS)

  for (const doc of exhausted) {
    await abandonDocument(doc.id, doc.attempts)
  }

  await mapWithConcurrency(retryable, concurrency, async (doc) => {
    await ingestDocument(doc.id, { trigger: 'recovery' })
  })

  logger.info('Ingestion recovery sweep', {
    stranded: stranded.length,
    resumed: retryable.length,
    abandoned: exhausted.length,
    concurrency,
  })

  return { resumed: retryable.length, abandoned: exhausted.length }
}

/**
 * Give up on a document that has been started `MAX_INGEST_ATTEMPTS` times and
 * never reached a terminal status (FR2).
 *
 * Only reachable when every one of those attempts died without running its own
 * catch block — i.e. it took the process down. The message says so, because
 * "try again" is bad advice for a file that has already crashed three workers.
 *
 * Guarded on the status still being transient rather than on a claim token:
 * this is written by the sweep, which by construction holds no claim on the
 * row, and the guard is what stops it stamping over a document that finished
 * between the SELECT and here.
 */
async function abandonDocument(
  documentId: string,
  attempts: number,
): Promise<void> {
  await db
    .update(documents)
    .set({
      status: 'failed',
      claimedAt: null,
      error:
        `Processing was interrupted ${attempts} times without completing. ` +
        'This document may be too large or malformed to index — remove it and ' +
        're-upload, or try a different export of the file.',
    })
    .where(
      and(
        eq(documents.id, documentId),
        inArray(documents.status, TRANSIENT_STATUSES),
      ),
    )

  logger.warn('Document abandoned after repeated interruptions', {
    documentId,
    attempts,
  })
}

/**
 * Start the background sweep, and return a function that stops it.
 *
 * Called once per server process from `src/instrumentation.ts`. Boot-only
 * recovery would miss a document stranded by a worker crash that did not take
 * the process down, so it is a timer as well — the same shape as the pull timer
 * that restarts the container in the first place.
 *
 * Re-entrancy matters: a sweep that recovers slow documents can easily outlast
 * the interval, and overlapping sweeps would select the same rows again. The
 * claim would still elect one winner, but the second sweep would burn a
 * database round trip per row to learn that, every minute, forever.
 */
export function startIngestionRecovery(
  options: { intervalMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? RECOVERY_INTERVAL_MS
  let running = false
  let stopped = false

  const sweep = async () => {
    if (running || stopped) return
    running = true
    try {
      await recoverStrandedDocuments()
    } catch (error) {
      // A sweep that throws must not kill the timer, or one transient database
      // blip permanently disables recovery for the life of the container.
      logger.error('Ingestion recovery sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void sweep(), intervalMs)
  // Never hold the process open for the sake of the sweep.
  timer.unref?.()
  void sweep()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
