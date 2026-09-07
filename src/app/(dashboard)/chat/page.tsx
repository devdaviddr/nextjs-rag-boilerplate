import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { ChatPanel } from '@/components/rag/chat-panel'
import { getCurrentSession } from '@/lib/auth/session'
import { listMyDocuments, ragStatus } from '@/lib/rag/actions'

export const metadata: Metadata = { title: 'Chat' }

export default async function ChatPage() {
  const session = await getCurrentSession()
  if (!session?.user) redirect('/login')

  const [documents, { configured }] = await Promise.all([
    listMyDocuments(),
    ragStatus(),
  ])
  const readyCount = documents.filter((d) => d.status === 'ready').length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Chat</h1>
        <p className="text-muted-foreground text-sm">
          Answers come only from your uploaded documents, with a citation for
          every source used.
        </p>
      </div>
      <ChatPanel configured={configured} readyDocumentCount={readyCount} />
    </div>
  )
}
