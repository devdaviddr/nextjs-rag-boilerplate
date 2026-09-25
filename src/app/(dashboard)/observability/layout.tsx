import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { ObservabilityTabs } from '@/components/observability/tabs'
import { hasRole } from '@/lib/auth/rbac'

export const metadata: Metadata = { title: 'Observability' }

/**
 * Observability (spec 0042): admins only. Anyone else gets a plain 404, as if
 * the area did not exist (FR11). Fills the shell's scrolling <main>, so each
 * page decides what scrolls.
 */
export default async function ObservabilityLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (!(await hasRole('admin'))) notFound()
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-4 pt-6 sm:px-6 lg:pt-8">
      <header className="mb-4 shrink-0 space-y-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Observability
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            What the RAG pipeline and its agents are doing.
          </p>
        </div>
        <ObservabilityTabs />
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
