import { NextResponse } from 'next/server'

import { hasRole } from '@/lib/auth/rbac'
import {
  countLogsByLevel,
  listLogs,
  parseLogFilters,
} from '@/lib/observability/queries'

/**
 * Log lines for Observability → Logs (spec 0042 FR7). Admins only, checked
 * here as well as by the page (FR11). Polled every couple of seconds with
 * `after=<last id>` for the live tail.
 */
export async function GET(request: Request) {
  if (!(await hasRole('admin'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const params = new URL(request.url).searchParams
  const filters = parseLogFilters(params)
  const num = (key: string) => {
    const v = Number(params.get(key))
    return params.has(key) && Number.isFinite(v) ? v : undefined
  }
  const [page, counts] = await Promise.all([
    listLogs(filters, {
      after: num('after'),
      before: num('before'),
      limit: num('limit'),
    }),
    params.get('counts') === '1' ? countLogsByLevel(filters) : null,
  ])
  return NextResponse.json(
    { ...page, counts },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
