/**
 * An in-process bus for one request's activity (spec 0042 FR12): the log
 * store and the run recorder publish, the chat route listens while it streams
 * an answer. Keyed by request id; a request with no listener costs one map
 * lookup per event.
 *
 * In-process is enough: a request's log lines and steps are written by the
 * server handling it, which is the one streaming its answer. On `globalThis`
 * so the startup hook's copy and the routes' copy are the same map.
 */

export type BusEvent =
  | {
      kind: 'log'
      time: string
      level: 'debug' | 'info' | 'warn' | 'error'
      category: string
      message: string
      meta: Record<string, unknown>
    }
  | {
      kind: 'step'
      phase: 'start' | 'end'
      key: number
      parentKey: number | null
      name: string
      offsetMs: number
      durationMs?: number
      status?: 'ok' | 'error' | 'cancelled'
      model?: string | null
      tokens?: number | null
    }

type Listener = (event: BusEvent) => void

const listeners: Map<string, Set<Listener>> = ((
  globalThis as { __appActivityBus?: Map<string, Set<Listener>> }
).__appActivityBus ??= new Map())

export function subscribe(requestId: string, listener: Listener): () => void {
  let set = listeners.get(requestId)
  if (!set) {
    set = new Set()
    listeners.set(requestId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(requestId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(requestId)
  }
}

export function hasListeners(requestId: string | undefined): boolean {
  return !!requestId && listeners.has(requestId)
}

/** Deliver to everyone listening; a failing listener never reaches the publisher. */
export function publish(requestId: string, event: BusEvent): void {
  const set = listeners.get(requestId)
  if (!set) return
  for (const listener of set) {
    try {
      listener(event)
    } catch {
      // A listener's problem is its own.
    }
  }
}
