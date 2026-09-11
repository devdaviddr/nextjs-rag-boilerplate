import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { DocumentInspector } from '@/components/rag/document-inspector'
import { getCurrentSession } from '@/lib/auth/session'
import { getDocumentTitle, inspectDocument } from '@/lib/rag/actions'
import { listMyKnowledgeBases } from '@/lib/rag/kb-actions'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ documentId: string }>
}): Promise<Metadata> {
  const { documentId } = await params
  // Deliberately NOT `inspectDocument`: that reads every chunk of the
  // document, and this needs one string.
  return { title: (await getDocumentTitle(documentId)) ?? 'Document' }
}

/**
 * What was indexed from one document (spec 0037 FR1).
 *
 * `inspectDocument` scopes to the caller in its `WHERE` clause and returns
 * `null` for a document that does not exist *and* for one belonging to someone
 * else, so `notFound()` here leaks nothing about which of the two it was
 * (NFR1). Read-only throughout — nothing on this route mutates anything.
 */
export default async function DocumentInspectPage({
  params,
}: {
  params: Promise<{ kbId: string; documentId: string }>
}) {
  const session = await getCurrentSession()
  if (!session?.user) redirect('/login')

  const { kbId, documentId } = await params
  const doc = await inspectDocument(documentId)
  if (!doc) notFound()

  // A document reached under the wrong knowledge base is still the caller's
  // own, but the breadcrumb would then lie about where it lives.
  if (doc.knowledgeBaseId !== kbId) notFound()

  const knowledgeBase = (await listMyKnowledgeBases()).find(
    (kb) => kb.id === kbId,
  )
  if (!knowledgeBase) notFound()

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <div>
        <Link
          href={`/documents/${kbId}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← {knowledgeBase.name}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{doc.title}</h1>
        <p className="text-muted-foreground text-sm">
          What was indexed from this document, page by page.
        </p>
      </div>
      <DocumentInspector
        documentId={documentId}
        title={doc.title}
        inspection={doc.inspection}
      />
    </div>
  )
}
