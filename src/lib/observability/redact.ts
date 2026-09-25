/**
 * Scrub secrets from a log line's details before it is stored (spec 0042
 * NFR2). Keys that name a secret are replaced whole; values that look like an
 * API key are replaced wherever they appear. Errors become plain objects,
 * long strings are cut, and the whole thing is bounded, so one huge line
 * cannot bloat the table.
 */

const SECRET_KEY =
  /(^|_|-)(api[-_]?key|secret|password|passwd|token|authorization|cookie|credentials?)($|_|-)|^key$/i
const SECRET_VALUE =
  /\b(nvapi-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g

export const REDACTED = '[redacted]'
const MAX_STRING = 4_000
const MAX_DEPTH = 6
const MAX_ITEMS = 100

function scrubString(value: string): string {
  const clean = value.replace(SECRET_VALUE, REDACTED)
  return clean.length > MAX_STRING
    ? `${clean.slice(0, MAX_STRING)}… (${clean.length - MAX_STRING} more characters)`
    : clean
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack
        ? scrubString(value.stack.split('\n').slice(0, 8).join('\n'))
        : undefined,
    }
  }
  if (depth >= MAX_DEPTH) return '[too deep]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => redact(v, depth + 1))
    if (value.length > MAX_ITEMS)
      items.push(`… ${value.length - MAX_ITEMS} more`)
    return items
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value).slice(0, MAX_ITEMS)) {
      out[key] =
        SECRET_KEY.test(key) &&
        v !== null &&
        v !== undefined &&
        typeof v !== 'boolean' &&
        typeof v !== 'number'
          ? REDACTED
          : redact(v, depth + 1)
    }
    return out
  }
  return String(value)
}
