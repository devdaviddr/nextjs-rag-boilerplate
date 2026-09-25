import 'server-only'

import { lt } from 'drizzle-orm'

import { type LogRecord, setLogContext, setLogSink } from '@/lib/logger'

import { hasListeners, publish } from './bus'
import { categorise } from './categorise'
import { currentContext } from './context'
import { redact } from './redact'

/**
 * Keeps log lines in Postgres for the Logs page (spec 0042 FR3, NFR1).
 *
 * Nothing here runs on the request path: `enqueue` only pushes onto an array.
 * A timer flushes the array in batches; a failed batch is dropped with one
 * line on stdout, never retried into a loop and never thrown to a caller. The
 * buffer is bounded, dropping the oldest lines if the database falls behind.
 *
 * Its own failures go to `console`, not `logger`, so a broken database cannot
 * feed log lines about itself back into the queue.
 */

export const FLUSH_MS = 1_000
export const BATCH_SIZE = 250
export const MAX_BUFFER = 5_000
const PRUNE_EVERY_MS = 60 * 60 * 1_000

export interface LogRow {
  time: Date
  level: string
  category: string
  message: string
  requestId: string | null
  userId: string | null
  meta: Record<string, unknown>
}

export type Writer = (rows: LogRow[]) => Promise<void>

/** Hand a line to the chat drawer watching its request, if one is. */
export function publishLine(record: LogRecord): void {
  const requestId = record.context?.requestId
  if (!requestId || !hasListeners(requestId)) return
  const row = toRow(record)
  publish(requestId, {
    kind: 'log',
    time: row.time.toISOString(),
    level: record.level,
    category: row.category,
    message: row.message,
    meta: row.meta,
  })
}

export function toRow(record: LogRecord): LogRow {
  const { context, meta } = record
  const { category: _category, ...rest } = meta
  void _category
  return {
    time: record.time,
    level: record.level,
    category: categorise(record.message, meta, context),
    message: String(redact(record.message)),
    requestId: context?.requestId ?? null,
    userId: context?.userId ?? null,
    meta: redact({
      ...rest,
      ...(context?.conversationId
        ? { conversationId: context.conversationId }
        : {}),
      ...(context?.documentId ? { documentId: context.documentId } : {}),
    }) as Record<string, unknown>,
  }
}

/** The queue and its flushing, separate from the timers so tests can drive it. */
export function createLogQueue(write: Writer) {
  let buffer: LogRow[] = []
  let dropped = 0
  let flushing: Promise<void> | null = null

  return {
    enqueue(record: LogRecord) {
      buffer.push(toRow(record))
      if (buffer.length > MAX_BUFFER) {
        const over = buffer.length - MAX_BUFFER
        buffer = buffer.slice(over)
        dropped += over
      }
    },
    size: () => buffer.length,
    dropped: () => dropped,
    async flush(): Promise<void> {
      if (flushing) return flushing
      flushing = (async () => {
        while (buffer.length > 0) {
          const batch = buffer.slice(0, BATCH_SIZE)
          buffer = buffer.slice(batch.length)
          try {
            await write(batch)
          } catch (err) {
            dropped += batch.length
            console.error(
              JSON.stringify({
                level: 'error',
                message: 'log-store: could not write log lines; dropped them',
                count: batch.length,
                error: err instanceof Error ? err.message : String(err),
              }),
            )
            break
          }
        }
      })().finally(() => {
        flushing = null
      })
      return flushing
    },
  }
}

async function writeRows(rows: LogRow[]): Promise<void> {
  const [{ db }, { appLogs }] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
  ])
  await db.insert(appLogs).values(rows)
}

async function prune(retentionDays: number): Promise<void> {
  const [{ db }, { appLogs }] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
  ])
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1_000)
  await db.delete(appLogs).where(lt(appLogs.time, cutoff))
}

const state = globalThis as { __appLogStoreStarted?: boolean }

/**
 * Called once per server process from `instrumentation.ts`. The request
 * context goes on stdout lines either way; the Postgres copy only when
 * `persist` is on.
 */
export function startLogStore({
  persist,
  retentionDays,
}: {
  persist: boolean
  retentionDays: number
}): void {
  // Once per process, even if dev reloads this module.
  if (state.__appLogStoreStarted) return
  state.__appLogStoreStarted = true
  setLogContext(currentContext)

  // Every line goes to anyone watching its request live (FR12), stored or not.
  const queue = persist ? createLogQueue(writeRows) : null
  setLogSink((record) => {
    publishLine(record)
    queue?.enqueue(record)
  })
  if (!queue) return
  setInterval(() => void queue.flush(), FLUSH_MS).unref()

  const runPrune = () =>
    prune(retentionDays).catch((err) =>
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'log-store: pruning old log lines failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    )
  setTimeout(runPrune, 30_000).unref()
  setInterval(runPrune, PRUNE_EVERY_MS).unref()
}
