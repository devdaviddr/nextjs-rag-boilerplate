import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { ChatView } from '@/components/chat/chat-view'
import { getCurrentSession } from '@/lib/auth/session'
import { getConversation } from '@/lib/chat/actions'
import { listMyKnowledgeBases } from '@/lib/rag/kb-actions'
import { ragStatus } from '@/lib/rag/actions'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const conversation = await getConversation(id)
  return { title: conversation?.title ?? 'Chat' }
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await getCurrentSession()
  if (!session?.user) redirect('/login')

  const { id } = await params
  const [conversation, knowledgeBases, { configured }] = await Promise.all([
    getConversation(id),
    listMyKnowledgeBases(),
    ragStatus(),
  ])

  // `getConversation` returns null both for a missing conversation and for
  // someone else's, so this is the same 404 either way — no existence signal.
  if (!conversation) notFound()

  return (
    <ChatView
      configured={configured}
      knowledgeBases={knowledgeBases}
      conversationId={conversation.id}
      knowledgeBaseIds={conversation.knowledgeBaseIds}
      initialMessages={conversation.messages}
    />
  )
}
