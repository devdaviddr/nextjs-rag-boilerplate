/**
 * Tiny structured-logging shim. Emits one JSON object per line so logs are
 * greppable and ingestible by any collector. Swap the sink for pino/winston or
 * ship to your platform without touching call sites.
 *
 * Dependency-free, so it is safe in the edge runtime. The Node side adds two
 * things through hooks rather than imports (spec 0042 NFR3):
 *
 * - `setLogContext` — who and what a line belongs to (the request id, the
 *   user), read from an AsyncLocalStorage the Node server sets up.
 * - `setLogSink` — a second destination; the Postgres store for the Logs page.
 *
 * A line can name its category with `{ category: 'agent' }` in its meta; the
 * store fills one in otherwise (`src/lib/observability/categorise.ts`).
 */
type Level = 'debug' | 'info' | 'warn' | 'error'

export type LogCategory =
  | 'agent'
  | 'retrieval'
  | 'inference'
  | 'ingestion'
  | 'auth'
  | 'settings'
  | 'system'

export interface LogContext {
  requestId?: string
  userId?: string
  conversationId?: string
  documentId?: string
  /** What kind of work this request is: a chat answer or an ingestion. */
  kind?: 'chat' | 'ingest'
}

export interface LogRecord {
  level: Level
  message: string
  time: Date
  context: LogContext | undefined
  meta: Record<string, unknown>
}

const WEIGHT: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const threshold =
  WEIGHT[(process.env.LOG_LEVEL as Level) ?? 'debug'] ??
  (process.env.NODE_ENV === 'production' ? WEIGHT.info : WEIGHT.debug)

interface Hooks {
  contextOf: (() => LogContext | undefined) | null
  sink: ((record: LogRecord) => void) | null
}

/**
 * On `globalThis`, not in module scope: Next.js bundles `instrumentation.ts`
 * and the app's routes as separate module graphs, so each gets its own copy
 * of this file. The hooks set at startup have to reach every copy.
 */
const hooks: Hooks = ((
  globalThis as { __appLogHooks?: Hooks }
).__appLogHooks ??= { contextOf: null, sink: null })

/** Where the current request's context comes from (Node only). */
export function setLogContext(fn: (() => LogContext | undefined) | null) {
  hooks.contextOf = fn
}

/** A second destination for every line that passes the level threshold. */
export function setLogSink(fn: ((record: LogRecord) => void) | null) {
  hooks.sink = fn
}

function emit(level: Level, message: string, meta?: Record<string, unknown>) {
  if (WEIGHT[level] < threshold) return
  const time = new Date()
  const context = hooks.contextOf?.()
  const line = JSON.stringify({
    level,
    message,
    time: time.toISOString(),
    ...(context?.requestId ? { requestId: context.requestId } : {}),
    ...meta,
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  if (hooks.sink) {
    try {
      hooks.sink({ level, message, time, context, meta: meta ?? {} })
    } catch {
      // The sink must never break the caller; it reports its own failures.
    }
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) =>
    emit('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) =>
    emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) =>
    emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    emit('error', message, meta),
}
