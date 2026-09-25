import { NextResponse } from 'next/server'

import { getCurrentSession } from '@/lib/auth/session'
import { searchIndex } from '@/lib/docs'

/**
 * The docs search index (spec 0041 FR7), fetched once by the search box the
 * first time it is used, then searched in the browser. The proxy already
 * guards /docs; the session is checked here too, as for /docs-assets.
 */
export async function GET() {
  const session = await getCurrentSession()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(
    { entries: searchIndex() },
    {
      headers: {
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  )
}
