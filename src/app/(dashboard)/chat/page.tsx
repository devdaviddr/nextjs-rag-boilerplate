import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { ChatView } from '@/components/chat/chat-view'
import { getCurrentSession } from '@/lib/auth/session'
import { listMyKnowledgeBases } from '@/lib/rag/kb-actions'
import { ragStatus } from '@/lib/rag/actions'

export const metadata: Metadata = { title: 'Chat' }

/** A new, unsaved conversation. It is created on the first message. */
export default async function NewChatPage() {
  const session = await getCurrentSession()
  if (!session?.user) redirect('/login')

  const [knowledgeBases, { configured }] = await Promise.all([
    listMyKnowledgeBases(),
    ragStatus(),
  ])

  return (
    <ChatView
      configured={configured}
      knowledgeBases={knowledgeBases}
      initialMessages={[]}
    />
  )
}
