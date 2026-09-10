import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Claiming, fencing and recovery (spec 0034).
 *
 * ## Why this suite fakes the driver rather than the ORM
 *
 * Every requirement here lives in a `WHERE` clause. The claim is mutual
 * exclusion *because* its predicate re-evaluates against the row the other
 * worker just wrote; the fence is safe *because* the terminal write carries
 * `claimed_at = <token>`. A `db.update()` mock that returns whatever the test
 * says would pass just as happily with those predicates deleted, which would
 * make this suite worse than nothing.
 *
 * So the database is faked one layer lower: a real Drizzle instance over
 * `pg-proxy`, whose driver callback hands the test the actual SQL string and
 * the actual bound parameters. No database, no network — but the assertions are
 * about the statements that would really be sent.
 */

interface Query {
  sql: string
  params: unknown[]
}

const state = vi.hoisted(() => ({
  queries: [] as Query[],
  /** Returns rows as records; the harness projects them positionally. */
  reply: null as
    | null
    | ((
        sql: string,
        params: unknown[],
      ) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>),
}))

/** Column names a statement projects, in order — `select …` or `… returning …`. */
function projection(sql: string): string[] {
  const returning = / returning (.+)$/.exec(sql)
  const source = returning?.[1]
    ? returning[1]
    : sql.startsWith('select ')
      ? sql.slice('select '.length, sql.indexOf(' from '))
      : ''
  if (!source) return []
  return source.split(', ').map((item) => {
    const quoted = item.match(/"([^"]+)"/g) ?? []
    return (quoted[quoted.length - 1] ?? '').replaceAll('"', '')
  })
}

vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  const schema =
    await vi.importActual<typeof import('@/db/schema')>('@/db/schema')

  const base = drizzle(
    async (sql: string, params: unknown[]) => {
      state.queries.push({ sql, params })
      const records = (await state.reply?.(sql, params)) ?? []
      const columns = projection(sql)
      return {
        rows: records.map((record) =>
          columns.map((column) => record[column] ?? null),
        ),
      }
    },
    { schema },
  )

  // pg-proxy has no transactions, and the transaction boundary is exactly what
  // FR5 is about — so it is stubbed with markers instead, letting a test assert
  // which statements were inside it. `Object.create` keeps every real builder
  // method working with `this` intact.
  const db = Object.create(base) as typeof base
  db.transaction = (async (callback: (tx: typeof base) => Promise<unknown>) => {
    state.queries.push({ sql: 'BEGIN', params: [] })
    const result = await callback(db)
    state.queries.push({ sql: 'COMMIT', params: [] })
    return result
  }) as typeof base.transaction

  return { db, schema }
})

vi.mock('@/lib/env', () => ({
  env: {
    RAG_CHUNK_TOKENS: 512,
    RAG_CHUNK_OVERLAP_TOKENS: 64,
    RAG_CRACK_RENDER_SCALE: 2.0,
  },
}))

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({ logger: loggerMock }))

const getObjectBuffer = vi.hoisted(() => vi.fn())
vi.mock('@/lib/storage/client', () => ({ getObjectBuffer }))

const embedPassages = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rag/embed', () => ({ embedPassages }))

const chunksFromPdf = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rag/crack', () => ({ chunksFromPdf }))

import type { ParsedPageCache } from '@/lib/rag/crack'
import {
  MAX_INGEST_ATTEMPTS,
  RECOVERY_CONCURRENCY,
  ingestDocument,
  recoverStrandedDocuments,
  startIngestionRecovery,
} from '@/lib/rag/ingest'

// --- fixtures ---------------------------------------------------------------

const DOC_ID = 'doc-1'

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    owner_id: 'user-1',
    knowledge_base_id: 'kb-1',
    file_id: 'file-1',
    title: 'Quarterly report',
    page_count: null,
    pages_processed: null,
    extraction: null,
    status: 'extracting',
    error: null,
    claimed_at: new Date('2026-09-11T00:00:00.000Z'),
    attempts: 1,
    created_at: new Date('2026-09-11T00:00:00.000Z'),
    updated_at: new Date('2026-09-11T00:00:00.000Z'),
    ...overrides,
  }
}

function summary(pagesProcessed: number) {
  return {
    pages: [
      {
        page: pagesProcessed,
        route: 'clean-text' as const,
        outcome: 'parsed' as const,
      },
    ],
    parseCalls: pagesProcessed,
    describeCalls: 0,
    cachedPages: 0,
    budgetExhausted: false,
  }
}

/** A crack run that reports one page and produces one chunk. */
function onePageDocument() {
  chunksFromPdf.mockImplementation(
    async (_buffer: Buffer, options: Record<string, unknown>) => {
      const onPageProcessed = options.onPageProcessed as
        ((n: number, s: unknown) => Promise<void>) | undefined
      await onPageProcessed?.(1, summary(1))
      return {
        chunks: [
          {
            content: 'body',
            heading: null,
            caption: null,
            pageNumber: 1,
            chunkIndex: 0,
            tokenCount: 4,
          },
        ],
        pageCount: 1,
        extraction: summary(1),
      }
    },
  )
}

/** The claim: the only statement that carries the expiry predicate. */
const isClaim = (q: Query) =>
  q.sql.startsWith('update "documents"') &&
  q.sql.includes('"documents"."claimed_at" is null or')

/** A write that ends the document's life cycle one way or the other. */
const isTerminal = (q: Query) =>
  q.sql.startsWith('update "documents"') &&
  (q.params.includes('ready') || q.params.includes('failed'))

const isSweepSelect = (sql: string) =>
  sql.startsWith('select "id", "attempts" from "documents"')

/**
 * The value bound to one column in a statement's SET list.
 *
 * Drizzle emits SET columns in table-definition order and binds everything,
 * including nulls, so assertions have to go through the parameter list rather
 * than pattern-match the SQL text.
 */
function setValue(q: Query, column: string): unknown {
  const setClause = q.sql.slice(0, q.sql.indexOf(' where '))
  const match = new RegExp(`"${column}" = \\$(\\d+)`).exec(setClause)
  return match?.[1] ? q.params[Number(match[1]) - 1] : undefined
}

/** Rows for the queries every happy-path run makes. */
function defaultReply(sql: string): Record<string, unknown>[] {
  if (sql.includes('from "files"')) return [{ bucket_key: 'bucket/key.pdf' }]
  if (sql.startsWith('update "documents"')) return [documentRow()]
  if (sql.startsWith('select "attempts"')) return [{ attempts: 1 }]
  return []
}

beforeEach(() => {
  state.queries.length = 0
  state.reply = null
  loggerMock.info.mockReset()
  loggerMock.warn.mockReset()
  loggerMock.error.mockReset()
  getObjectBuffer.mockReset().mockResolvedValue(Buffer.from('pdf'))
  embedPassages
    .mockReset()
    .mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2]))
  chunksFromPdf.mockReset()
  onePageDocument()
})

afterEach(() => {
  vi.useRealTimers()
})

// --- claiming (FR4) ---------------------------------------------------------

describe('claiming a document', () => {
  it('takes it with a conditional update on an absent or expired claim', async () => {
    state.reply = defaultReply

    await ingestDocument(DOC_ID)

    const claim = state.queries[0]
    expect(claim && isClaim(claim)).toBe(true)
    // The whole of FR4 is this predicate. Postgres serialises two of these on
    // the row, so the loser re-evaluates against the winner's `claimed_at` and
    // matches nothing.
    expect(claim?.sql).toContain(
      '"documents"."claimed_at" is null or "documents"."claimed_at" < ',
    )
    // Stamped from a bound JS Date, never `now()`. It doubles as the fencing
    // token every later write compares against, and Postgres stores
    // microseconds while a JS Date carries milliseconds — a token taken from
    // `now()` would be truncated on the way out and match nothing on the way
    // back in. Millisecond precision here is the proof.
    expect(setValue(claim!, 'claimed_at')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    )
    // The claim and the move into `extracting` are the same statement, so a
    // document can never be claimed without its status saying so.
    expect(setValue(claim!, 'status')).toBe('extracting')
  })

  it('does nothing when another worker already holds it', async () => {
    state.reply = (sql) =>
      sql.startsWith('select "attempts"') ? [{ attempts: 1 }] : []

    await ingestDocument(DOC_ID)

    expect(getObjectBuffer).not.toHaveBeenCalled()
    expect(state.queries.filter(isTerminal)).toHaveLength(0)
    expect(loggerMock.info).toHaveBeenCalledWith(
      'Ingestion skipped',
      expect.objectContaining({ reason: 'held' }),
    )
  })

  it('lets exactly one of two concurrent workers through', async () => {
    // The driver stands in for the row lock: whoever gets there first sets
    // `claimed_at`, and the other's predicate no longer holds.
    let claimedAt: Date | null = null
    state.reply = async (sql, params) => {
      const query = { sql, params }
      if (isClaim(query)) {
        const token = setValue(query, 'claimed_at') as Date
        const expiredBefore = params[params.length - 1] as Date
        if (claimedAt !== null && claimedAt >= expiredBefore) return []
        claimedAt = token
        return [documentRow({ claimed_at: token })]
      }
      return defaultReply(sql)
    }

    await Promise.all([ingestDocument(DOC_ID), ingestDocument(DOC_ID)])

    expect(getObjectBuffer).toHaveBeenCalledTimes(1)
  })
})

// --- fencing ----------------------------------------------------------------

describe('a run whose lease is taken from under it', () => {
  it('stops at the next page instead of finishing', async () => {
    // The claim lands; the heartbeat's fence does not.
    state.reply = (sql, params) =>
      isClaim({ sql, params }) || !sql.startsWith('update "documents"')
        ? defaultReply(sql)
        : []

    await ingestDocument(DOC_ID)

    expect(embedPassages).not.toHaveBeenCalled()
    expect(state.queries.some((q) => q.sql === 'BEGIN')).toBe(false)
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Ingestion abandoned — claim lost',
      expect.objectContaining({ documentId: DOC_ID }),
    )
  })

  it('never stamps its own outcome over the winner’s', async () => {
    // Claim succeeds, heartbeats succeed, and the terminal write is fenced out
    // because the replacement worker already finished the document.
    state.reply = (sql) =>
      / returning "id"$/.test(sql) ? [] : defaultReply(sql)
    chunksFromPdf.mockImplementation(async () => {
      throw new Error('parser exploded')
    })

    await ingestDocument(DOC_ID)

    const failed = state.queries.filter((q) =>
      q.params.includes(
        'Processing failed. Please try again, or remove and re-upload this document.',
      ),
    )
    // The statement is issued — it just matches no row, which is the point.
    expect(failed).toHaveLength(1)
    expect(failed[0]?.sql).toContain('"documents"."claimed_at" = ')
  })

  it('fences the success path on the same token', async () => {
    state.reply = defaultReply

    await ingestDocument(DOC_ID)

    const ready = state.queries.find((q) => q.params.includes('ready'))
    expect(ready?.sql).toContain('"documents"."claimed_at" = ')
    // Released here and only here: a terminal row holding a claim is invisible
    // to the sweep for a window, which is never what anyone wants.
    expect(setValue(ready!, 'claimed_at')).toBeNull()
    // And the retry history goes with it, so the next user-initiated run does
    // not look like a crash loop to the sweep.
    expect(setValue(ready!, 'attempts')).toBe(0)
  })
})

// --- idempotence (FR5) ------------------------------------------------------

describe('the chunk write', () => {
  it('is one delete-then-insert transaction, and nothing else', async () => {
    state.reply = defaultReply

    await ingestDocument(DOC_ID)

    const begin = state.queries.findIndex((q) => q.sql === 'BEGIN')
    const commit = state.queries.findIndex((q) => q.sql === 'COMMIT')
    expect(begin).toBeGreaterThan(-1)
    const inside = state.queries.slice(begin + 1, commit).map((q) => q.sql)
    expect(inside).toHaveLength(2)
    expect(inside[0]).toContain('delete from "chunks"')
    expect(inside[1]).toContain('insert into "chunks"')
    // Exactly one transaction per run: two workers that both finish therefore
    // each replace the whole set, and neither can leave a partial one.
    expect(state.queries.filter((q) => q.sql === 'BEGIN')).toHaveLength(1)
  })
})

// --- the parse cache (FR3) --------------------------------------------------

describe('the parse cache handed to cracking', () => {
  async function captureCache(): Promise<ParsedPageCache> {
    state.reply = defaultReply
    await ingestDocument(DOC_ID)
    const options = chunksFromPdf.mock.calls[0]?.[1] as {
      parseCache: ParsedPageCache
    }
    state.queries.length = 0
    return options.parseCache
  }

  it('reads by file, page and render scale', async () => {
    const cache = await captureCache()
    state.reply = () => []

    await cache.get(7)

    const read = state.queries[0]
    expect(read?.sql).toContain('from "parsed_pages"')
    expect(read?.params).toEqual(expect.arrayContaining(['file-1', 7, 2.0]))
  })

  it('upserts, so a re-parse replaces rather than accumulates', async () => {
    const cache = await captureCache()
    state.reply = () => []

    await cache.set(3, [
      {
        type: 'Text',
        text: 'hello',
        bbox: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      },
    ])

    const write = state.queries[0]
    expect(write?.sql).toContain('insert into "parsed_pages"')
    expect(write?.sql).toContain('on conflict ("file_id","page") do update set')
  })

  it('is dropped once the document is ready, and kept when it fails', async () => {
    state.reply = defaultReply
    await ingestDocument(DOC_ID)
    expect(
      state.queries.some((q) => q.sql.startsWith('delete from "parsed_pages"')),
    ).toBe(true)

    state.queries.length = 0
    chunksFromPdf.mockImplementation(async () => {
      throw new Error('parser exploded')
    })
    await ingestDocument(DOC_ID)
    // Kept on failure on purpose: it is what makes the user's next Retry cheap.
    expect(
      state.queries.some((q) => q.sql.startsWith('delete from "parsed_pages"')),
    ).toBe(false)
  })
})

// --- bounded retry (FR2) ----------------------------------------------------

describe('attempt bounding', () => {
  it('spends an attempt on a recovery run and caps it', async () => {
    state.reply = defaultReply

    await ingestDocument(DOC_ID, { trigger: 'recovery' })

    const claim = state.queries.find(isClaim)
    expect(claim?.sql).toContain('"attempts" = "documents"."attempts" + 1')
    expect(claim?.sql).toContain('"documents"."attempts" < ')
    expect(claim?.params).toContain(MAX_INGEST_ATTEMPTS)
  })

  it('does not spend one when a person asked for the run', async () => {
    state.reply = defaultReply

    await ingestDocument(DOC_ID, { trigger: 'request' })

    const claim = state.queries.find(isClaim)
    // A user pressing Retry restarts the budget; only the sweep can loop, so
    // only the sweep is bounded by it.
    expect(claim?.sql).not.toContain('"documents"."attempts" < ')
    expect(setValue(claim!, 'attempts')).toBe(1)
  })

  it('reports an exhausted document as skipped, not failed, from the worker', async () => {
    state.reply = (sql) =>
      sql.startsWith('select "attempts"')
        ? [{ attempts: MAX_INGEST_ATTEMPTS }]
        : []

    await ingestDocument(DOC_ID, { trigger: 'recovery' })

    expect(loggerMock.info).toHaveBeenCalledWith(
      'Ingestion skipped',
      expect.objectContaining({ reason: 'exhausted' }),
    )
    expect(state.queries.filter(isTerminal)).toHaveLength(0)
  })
})

// --- the sweep (FR1, FR2, NFR2) ---------------------------------------------

describe('recoverStrandedDocuments', () => {
  it('selects only transient rows with a stale claim, oldest first', async () => {
    state.reply = () => []

    await recoverStrandedDocuments()

    const select = state.queries[0]
    expect(select?.sql).toContain('from "documents"')
    expect(select?.sql).toContain('"documents"."status" in ($1, $2, $3)')
    expect(select?.params.slice(0, 3)).toEqual([
      'pending',
      'extracting',
      'embedding',
    ])
    // A live run heartbeats every page, so it fails this predicate and cannot
    // have its work stolen.
    expect(select?.sql).toContain('"documents"."claimed_at" is null')
    expect(select?.sql).toContain('"documents"."claimed_at" < ')
    // The grace period is what keeps "just uploaded" distinguishable from
    // "stuck" (NFR3).
    expect(select?.sql).toContain('"documents"."updated_at" < ')
    expect(select?.sql).toContain('order by "documents"."updated_at" asc')
    expect(select?.sql).toContain('limit')
  })

  it('resumes a stranded document without anyone asking', async () => {
    state.reply = (sql) =>
      isSweepSelect(sql) ? [{ id: DOC_ID, attempts: 1 }] : defaultReply(sql)

    const result = await recoverStrandedDocuments()

    expect(result).toEqual({ resumed: 1, abandoned: 0 })
    expect(state.queries.some((q) => q.params.includes('ready'))).toBe(true)
  })

  it('gives up on a document that has been interrupted to the cap', async () => {
    state.reply = (sql) =>
      isSweepSelect(sql)
        ? [{ id: DOC_ID, attempts: MAX_INGEST_ATTEMPTS }]
        : defaultReply(sql)

    const result = await recoverStrandedDocuments()

    expect(result).toEqual({ resumed: 0, abandoned: 1 })
    const abandon = state.queries.find(isTerminal)
    expect(abandon?.params).toContain('failed')
    expect(abandon?.params).toContainEqual(
      expect.stringContaining('interrupted 3 times'),
    )
    // Guarded on the status, not a claim: the sweep holds no claim on this row,
    // and this must not overwrite a document that finished a moment ago.
    expect(abandon?.sql).toContain('"documents"."status" in ')
    // And it is never claimed again.
    expect(state.queries.filter(isClaim)).toHaveLength(0)
  })

  it('recovers a crowd no faster than the concurrency limit (NFR2)', async () => {
    const stranded = Array.from({ length: 50 }, (_, i) => ({
      id: `doc-${i}`,
      attempts: 1,
    }))
    state.reply = (sql) => (isSweepSelect(sql) ? stranded : defaultReply(sql))

    let inFlight = 0
    let peak = 0
    chunksFromPdf.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight--
      return { chunks: [], pageCount: 0, extraction: summary(0) }
    })

    // No chunks means every document fails, which is fine — what is under test
    // is how many cracking runs were open at once.
    await recoverStrandedDocuments({ limit: 50 })

    expect(peak).toBeLessThanOrEqual(RECOVERY_CONCURRENCY)
    expect(chunksFromPdf).toHaveBeenCalledTimes(50)
  })
})

// --- the timer --------------------------------------------------------------

describe('startIngestionRecovery', () => {
  it('sweeps on boot and on the interval, never overlapping itself', async () => {
    vi.useFakeTimers()
    let open = 0
    let peak = 0
    // A sweep that outlasts its own interval — the case that would otherwise
    // have two sweeps selecting the same rows every minute forever.
    state.reply = async (sql) => {
      if (isSweepSelect(sql)) {
        open++
        peak = Math.max(peak, open)
        await new Promise((resolve) => setTimeout(resolve, 2500))
        open--
      }
      return []
    }

    const stop = startIngestionRecovery({ intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(6000)
    const sweeps = state.queries.length
    stop()
    await vi.advanceTimersByTimeAsync(6000)

    // Once on boot — a container restart is the reason this exists — and again
    // on the timer, because a worker can die without taking the process down.
    expect(sweeps).toBeGreaterThanOrEqual(2)
    expect(peak).toBe(1)
    // Stopping means stopping: nothing more is issued after the container has
    // asked the timer to go away.
    expect(state.queries.length).toBe(sweeps)
  })

  it('survives a sweep that throws, so one blip is not permanent', async () => {
    vi.useFakeTimers()
    state.reply = () => {
      throw new Error('connection reset')
    }

    const stop = startIngestionRecovery({ intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(2500)
    stop()

    expect(loggerMock.error).toHaveBeenCalledWith(
      'Ingestion recovery sweep failed',
      expect.objectContaining({
        error: expect.stringContaining('Failed query'),
      }),
    )
    // The point: a database blip must not silently disable recovery for the
    // life of the container, so the timer keeps firing after one throws.
    expect(state.queries.length).toBeGreaterThanOrEqual(2)
  })
})
