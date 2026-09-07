import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { KnowledgeBasesPanel } from '@/components/rag/knowledge-bases-panel'
import { getCurrentSession } from '@/lib/auth/session'
import { listMyKnowledgeBases } from '@/lib/rag/kb-actions'

export const metadata: Metadata = { title: 'Knowledge bases' }

export default async function DocumentsPage() {
  const session = await getCurrentSession()
  if (!session?.user) redirect('/login')

  const knowledgeBases = await listMyKnowledgeBases()

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold">Knowledge bases</h1>
        <p className="text-muted-foreground text-sm">
          Upload PDFs into a knowledge base to ask questions about them. Only
          you can see or search your knowledge bases.
        </p>
      </div>
      <KnowledgeBasesPanel initialKnowledgeBases={knowledgeBases} />
    </div>
  )
}
