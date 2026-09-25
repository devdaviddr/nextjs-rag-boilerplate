import 'server-only'

import { AsyncLocalStorage } from 'node:async_hooks'

import type { LogContext } from '@/lib/logger'

/**
 * The request a piece of work belongs to (spec 0042 FR4). Every log line and
 * telemetry step written inside `withRequestContext` carries its request id,
 * without any call site passing it along.
 */
// Shared through `globalThis` for the same reason as the logger's hooks: the
// startup hook and the routes are separate bundles with their own modules.
const storage: AsyncLocalStorage<LogContext> = ((
  globalThis as { __appRequestContext?: AsyncLocalStorage<LogContext> }
).__appRequestContext ??= new AsyncLocalStorage<LogContext>())

export function currentContext(): LogContext | undefined {
  return storage.getStore()
}

export function newRequestId(): string {
  return crypto.randomUUID()
}

/** Run `fn` as part of a request; nested calls add to the outer context. */
export function withRequestContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn)
}

/**
 * Add to the current request's context once more is known (the user after
 * sign-in is checked, the conversation after it is created). A no-op outside
 * a request.
 */
export function annotateContext(more: Partial<LogContext>): void {
  const store = storage.getStore()
  if (store) Object.assign(store, more)
}
