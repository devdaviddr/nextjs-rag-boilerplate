import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { DocumentsPanel } from '@/components/rag/documents-panel'
import { getCurrentSession } from '@/lib/auth/session'
import { listMyKnowledgeBases } from '@/lib/rag/kb-actions'
import { listMyDocuments, ragStatus } from '@/lib/rag/actions'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ kbId: string }>
}): Promise<Metadata> {
  const { kbId } = await params
  const knowledgeBases = await listMyKnowledgeBases()
  const knowledgeBase = knowledgeBases.find((kb) => kb.id === kbId)
  return { title: knowledgeBase?.name ?? 'Knowledge base' }
}

export default async function KnowledgeBasePage({
  params,
}: {
  params: Promise<{ kbId: string }>
}) {
  const session = await getCurrentSession()
  if (!session?.user) redirect('/login')

  const { kbId } = await params
  const [knowledgeBases, { configured }] = await Promise.all([
    listMyKnowledgeBases(),
    ragStatus(),
  ])

  // `listMyKnowledgeBases` only ever returns the caller's own rows, so an
  // unknown id and someone else's id both simply fail to appear here — the
  // same 404 either way, no existence signal.
  const knowledgeBase = knowledgeBases.find((kb) => kb.id === kbId)
  if (!knowledgeBase) notFound()

  const initialDocuments = await listMyDocuments(knowledgeBase.id)

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <div>
        <Link
          href="/documents"
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Knowledge bases
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{knowledgeBase.name}</h1>
        {knowledgeBase.description && (
          <p className="text-muted-foreground text-sm">
            {knowledgeBase.description}
          </p>
        )}
      </div>
      <DocumentsPanel
        knowledgeBaseId={knowledgeBase.id}
        knowledgeBases={knowledgeBases}
        initialDocuments={initialDocuments}
        configured={configured}
      />
    </div>
  )
}
