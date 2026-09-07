/**
 * Minimal in-memory rate limiter (fixed window).
 *
 * Good enough for a single instance. For serverless or multi-instance
 * deployments, swap the store for a shared backend such as
 * `@upstash/ratelimit` — keep the `rateLimit()` signature and only the storage
 * changes.
 *
 * NOTE: this limits per key. Login attempts are limited twice: per IP+email
 * (brute force against one account) and globally per IP (`loginPerIp` —
 * credential stuffing across many accounts from one source). Registrations
 * are keyed by IP.
 */
export interface RateLimitResult {
  success: boolean
  remaining: number
  /** Epoch ms when the current window resets. */
  resetAt: number
}

interface Bucket {
  count: number
  resetAt: number
}

const store = new Map<string, Bucket>()

export const AUTH_LIMITS = {
  login: { limit: 8, windowMs: 10 * 60_000 },
  // Global per-IP cap across ALL accounts — blunts credential stuffing while
  // still allowing a handful of users behind one NAT to mistype passwords.
  loginPerIp: { limit: 50, windowMs: 10 * 60_000 },
  register: { limit: 20, windowMs: 10 * 60_000 },
} as const

export const UPLOAD_LIMITS = {
  upload: { limit: 20, windowMs: 10 * 60_000 },
} as const

// Document chat spends a finite free-tier inference quota, so it is limited
// per user in the same way uploads are (spec 0025 NFR3).
export const RAG_LIMITS = {
  chat: { limit: 30, windowMs: 10 * 60_000 },
} as const

/** Disable in environments (e.g. certain test runs) via env. */
const DISABLED = process.env.RATE_LIMIT_DISABLED === 'true'

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  if (DISABLED)
    return { success: true, remaining: limit, resetAt: now + windowMs }

  const existing = store.get(key)

  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    // Opportunistic cleanup so the map can't grow unbounded.
    if (store.size > 10_000) {
      for (const [k, v] of store) if (v.resetAt <= now) store.delete(k)
    }
    return { success: true, remaining: limit - 1, resetAt: now + windowMs }
  }

  if (existing.count >= limit) {
    return { success: false, remaining: 0, resetAt: existing.resetAt }
  }

  existing.count += 1
  return {
    success: true,
    remaining: limit - existing.count,
    resetAt: existing.resetAt,
  }
}

/** Test helper — clear one key or the whole store. */
export function resetRateLimit(key?: string): void {
  if (key) store.delete(key)
  else store.clear()
}
