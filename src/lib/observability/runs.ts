import 'server-only'

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Runs and their steps (spec 0042 FR8): every question, and every ingestion,
 * recorded as a run of timed steps, in the shape OpenTelemetry uses for a
 * trace and its spans, so it could be exported later.
 *
 * `startRun` opens a run for the current request; `span(name, fn)` times a
 * step and nests anything inside it; `annotateSpan` adds to the step that is
 * running, which is how the inference client records the model and tokens of
 * whatever step called it. Outside a run every one of these is a no-op, so
 * the pipeline's functions behave exactly as before in tests and scripts.
 *
 * A run is written once, when it finishes, off the request path. A failed
 * write is dropped with a line on stdout: telemetry never fails a request.
 */

export type SpanStatus = 'ok' | 'error' | 'cancelled'
export type RunKind = 'question' | 'ingest'
export type RunStatus = 'ok' | 'refused' | 'error' | 'cancelled'

export interface SpanRecord {
  key: number
  parentKey: number | null
  name: string
  startedAt: Date
  durationMs: number
  status: SpanStatus
  model: string | null
  tokens: number | null
  attributes: Record<string, unknown>
}

export interface RunFields {
  status: RunStatus
  mode?: 'search' | 'document' | 'agentic' | null
  termination?: string | null
  ttftMs?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
  bestSimilarity?: number | null
  sourceCount?: number | null
  error?: string | null
}

export interface RunInit {
  id: string
  kind: RunKind
  userId?: string | null
  conversationId?: string | null
  documentId?: string | null
  question?: string | null
}

export interface RunRecord extends RunInit, RunFields {
  startedAt: Date
  durationMs: number
  totalTokens: number
  models: string[]
  spans: SpanRecord[]
}

export type RunWriter = (run: RunRecord) => Promise<void>

interface Frame {
  run: Run
  /** The span that is running, which new spans nest under. */
  span: SpanRecord | null
}

const storage: AsyncLocalStorage<Frame> = ((
  globalThis as { __appRunContext?: AsyncLocalStorage<Frame> }
).__appRunContext ??= new AsyncLocalStorage<Frame>())

const hooks = ((
  globalThis as { __appRunWriter?: { write: RunWriter | null } }
).__appRunWriter ??= { write: null })

/** Where finished runs go; set once from `instrumentation.ts`. */
export function setRunWriter(write: RunWriter | null): void {
  hooks.write = write
}

export class Run {
  readonly started = performance.now()
  readonly startedAt = new Date()
  readonly spans: SpanRecord[] = []
  private nextKey = 1
  private finished = false

  constructor(readonly init: RunInit) {}

  key(): number {
    return this.nextKey++
  }

  /** Close the run and hand it to the writer. Only the first call counts. */
  finish(fields: RunFields): RunRecord | null {
    if (this.finished) return null
    this.finished = true
    const models = [
      ...new Set(
        this.spans.map((s) => s.model).filter((m): m is string => !!m),
      ),
    ]
    const record: RunRecord = {
      ...this.init,
      ...fields,
      startedAt: this.startedAt,
      durationMs: Math.round(performance.now() - this.started),
      totalTokens: this.spans.reduce((sum, s) => sum + (s.tokens ?? 0), 0),
      models,
      spans: [...this.spans].sort((a, b) => a.key - b.key),
    }
    const write = hooks.write
    if (write) {
      void write(record).catch((err: unknown) =>
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'runs: could not store a run; dropped it',
            runId: record.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
    }
    return record
  }
}

/**
 * Open a run for the rest of the current async flow (the request handler and
 * everything it starts, the answer stream included).
 */
export function startRun(init: RunInit): Run {
  const run = new Run(init)
  storage.enterWith({ run, span: null })
  return run
}

export function currentRun(): Run | null {
  return storage.getStore()?.run ?? null
}

export interface SpanHandle {
  /** Add details to this step: a query, a count, a score. */
  set(attributes: Record<string, unknown>): void
}

const NOOP: SpanHandle = { set() {} }

function aborted(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Time `fn` as a step of the current run; a plain call outside one. */
export async function span<T>(
  name: string,
  fn: (span: SpanHandle) => Promise<T> | T,
  attributes: Record<string, unknown> = {},
): Promise<T> {
  const frame = storage.getStore()
  if (!frame) return fn(NOOP)
  const { run } = frame
  const record: SpanRecord = {
    key: run.key(),
    parentKey: frame.span?.key ?? null,
    name,
    startedAt: new Date(),
    durationMs: 0,
    status: 'ok',
    model: null,
    tokens: null,
    attributes: { ...attributes },
  }
  const started = performance.now()
  const handle: SpanHandle = {
    set: (more) => Object.assign(record.attributes, more),
  }
  try {
    return await storage.run({ run, span: record }, () => fn(handle))
  } catch (error) {
    record.status = aborted(error) ? 'cancelled' : 'error'
    record.attributes.error =
      error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    record.durationMs = Math.round(performance.now() - started)
    run.spans.push(record)
  }
}

/**
 * A step that does not fit in one callback, like a stream drained across a
 * loop: begin it, then `end` it. It does not become the parent of steps
 * started meanwhile.
 */
export function beginSpan(
  name: string,
  attributes: Record<string, unknown> = {},
): {
  set(attributes: Record<string, unknown>): void
  end(result?: {
    status?: SpanStatus
    model?: string | null
    tokens?: number | null
  }): void
} {
  const frame = storage.getStore()
  if (!frame) return { set() {}, end() {} }
  const { run } = frame
  const record: SpanRecord = {
    key: run.key(),
    parentKey: frame.span?.key ?? null,
    name,
    startedAt: new Date(),
    durationMs: 0,
    status: 'ok',
    model: null,
    tokens: null,
    attributes: { ...attributes },
  }
  const started = performance.now()
  let ended = false
  return {
    set: (more) => Object.assign(record.attributes, more),
    end: (result = {}) => {
      if (ended) return
      ended = true
      record.durationMs = Math.round(performance.now() - started)
      record.status = result.status ?? 'ok'
      record.model = result.model ?? record.model
      record.tokens = result.tokens ?? record.tokens
      run.spans.push(record)
    },
  }
}

/**
 * Add to the step that is running: its model, tokens (added up across calls)
 * and details. The inference client calls this, so each step records the
 * model it actually used without its call site passing it.
 */
export function annotateSpan(more: {
  model?: string
  tokens?: number | null
  attributes?: Record<string, unknown>
}): void {
  const record = storage.getStore()?.span
  if (!record) return
  if (more.model) record.model = more.model
  if (typeof more.tokens === 'number') {
    record.tokens = (record.tokens ?? 0) + more.tokens
  }
  if (more.attributes) Object.assign(record.attributes, more.attributes)
}
