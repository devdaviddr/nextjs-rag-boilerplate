import type { Metadata } from 'next'

import { LogConsole } from '@/components/observability/log-console'

export const metadata: Metadata = { title: 'Logs · Observability' }

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ requestId?: string }>
}) {
  const { requestId } = await searchParams
  return <LogConsole initialRequestId={requestId ?? null} />
}
