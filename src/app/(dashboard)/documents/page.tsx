import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { DocumentsPanel } from '@/components/rag/documents-panel'
import { getCurrentSession } from '@/lib/auth/session'
import { listMyDocuments, ragStatus } from '@/lib/rag/actions'

export const metadata: Metadata = { title: 'Knowledge base' }

export default async function DocumentsPage() {
  const session = await getCurrentSession()
  if (!session?.user) redirect('/login')

  const [initialDocuments, { configured }] = await Promise.all([
    listMyDocuments(),
    ragStatus(),
  ])

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold">Knowledge base</h1>
        <p className="text-muted-foreground text-sm">
          Upload PDFs to ask questions about them. Only you can see or search
          your documents.
        </p>
      </div>
      <DocumentsPanel
        initialDocuments={initialDocuments}
        configured={configured}
      />
    </div>
  )
}
