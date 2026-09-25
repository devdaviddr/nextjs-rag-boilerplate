import 'server-only'

import {
  type SQL,
  and,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  or,
  sql,
} from 'drizzle-orm'

import { db } from '@/db'
import { appLogs } from '@/db/schema'
import type { LogCategory } from '@/lib/logger'

import { LOG_CATEGORIES } from './categorise'

/** Reads for the Observability pages (spec 0042). Admin checks are the callers'. */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface LogFilters {
  levels?: LogLevel[]
  categories?: LogCategory[]
  q?: string
  requestId?: string
}

export interface LogLine {
  id: number
  time: string
  level: LogLevel
  category: LogCategory
  message: string
  requestId: string | null
  userId: string | null
  meta: Record<string, unknown>
}

/** Parse filters from a query string, dropping anything unknown. */
export function parseLogFilters(params: URLSearchParams): LogFilters {
  const list = (key: string) =>
    (params.get(key) ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  const levels = list('levels').filter((l): l is LogLevel =>
    (LOG_LEVELS as readonly string[]).includes(l),
  )
  const categories = list('categories').filter((c): c is LogCategory =>
    (LOG_CATEGORIES as readonly string[]).includes(c),
  )
  const q = params.get('q')?.trim().slice(0, 200)
  const requestId = params.get('requestId')?.trim().slice(0, 100)
  return {
    ...(levels.length ? { levels } : {}),
    ...(categories.length ? { categories } : {}),
    ...(q ? { q } : {}),
    ...(requestId ? { requestId } : {}),
  }
}

function where(filters: LogFilters, withLevels = true): SQL[] {
  const clauses: SQL[] = []
  if (withLevels && filters.levels?.length) {
    clauses.push(inArray(appLogs.level, filters.levels))
  }
  if (filters.categories?.length) {
    clauses.push(inArray(appLogs.category, filters.categories))
  }
  if (filters.requestId) clauses.push(eq(appLogs.requestId, filters.requestId))
  if (filters.q) {
    const pattern = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    clauses.push(
      or(
        ilike(appLogs.message, pattern),
        sql`${appLogs.meta}::text ilike ${pattern}`,
      )!,
    )
  }
  return clauses
}

function toLine(row: typeof appLogs.$inferSelect): LogLine {
  return {
    id: row.id,
    time: row.time.toISOString(),
    level: row.level as LogLevel,
    category: row.category as LogCategory,
    message: row.message,
    requestId: row.requestId,
    userId: row.userId,
    meta: row.meta ?? {},
  }
}

/**
 * A page of log lines, oldest first. `after` gives the lines newer than an id
 * (live tail); `before` the page older than one (load more); neither, the
 * newest page.
 */
export async function listLogs(
  filters: LogFilters,
  {
    after,
    before,
    limit = 300,
  }: { after?: number; before?: number; limit?: number },
): Promise<{ lines: LogLine[]; hasOlder: boolean }> {
  const clauses = where(filters)
  const size = Math.min(Math.max(limit, 1), 1_000)
  if (after !== undefined) {
    const rows = await db
      .select()
      .from(appLogs)
      .where(and(...clauses, gt(appLogs.id, after)))
      .orderBy(appLogs.id)
      .limit(size)
    return { lines: rows.map(toLine), hasOlder: false }
  }
  if (before !== undefined) clauses.push(lt(appLogs.id, before))
  const rows = await db
    .select()
    .from(appLogs)
    .where(and(...clauses))
    .orderBy(desc(appLogs.id))
    .limit(size + 1)
  return {
    lines: rows.slice(0, size).reverse().map(toLine),
    hasOlder: rows.length > size,
  }
}

/** Lines per level in the last 24 hours, for the level toggles. */
export async function countLogsByLevel(
  filters: LogFilters,
): Promise<Record<LogLevel, number>> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000)
  const rows = await db
    .select({ level: appLogs.level, n: sql<number>`count(*)::int` })
    .from(appLogs)
    .where(and(...where(filters, false), gte(appLogs.time, since)))
    .groupBy(appLogs.level)
  const out = { debug: 0, info: 0, warn: 0, error: 0 }
  for (const r of rows) {
    if (r.level in out) out[r.level as LogLevel] = r.n
  }
  return out
}
