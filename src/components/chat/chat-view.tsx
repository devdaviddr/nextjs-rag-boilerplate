'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ExternalLink, Send, X } from 'lucide-react'

import { FormMessage } from '@/components/auth/field-error'
import { Markdown } from '@/components/chat/markdown'
import { Thinking } from '@/components/chat/thinking'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { StoredCitation, StoredMetrics } from '@/db/schema'
import type { ConversationMessage } from '@/lib/chat/actions'
import { formatMetrics } from '@/lib/chat/metrics'
import { cn } from '@/lib/utils'

/**
 * The chat surface (spec 0026).
 *
 * Empty, it is a centred greeting with the composer beneath it. On the first
 * message it becomes a scrolling transcript with a pinned composer — in place,
 * without a navigation, so nothing flashes and the stream is never interrupted.
 */

interface StreamEvent {
  type: 'conversation' | 'citations' | 'token' | 'metrics' | 'done' | 'error'
  conversationId?: string
  title?: string
  citations?: StoredCitation[]
  metrics?: StoredMetrics
  value?: string
  message?: string
}

export function ChatView({
  configured,
  readyDocumentCount,
  conversationId: initialConversationId,
  initialMessages,
}: {
  configured: boolean
  readyDocumentCount: number
  conversationId?: string
  initialMessages: ConversationMessage[]
}) {
  const router = useRouter()
  const [messages, setMessages] =
    useState<ConversationMessage[]>(initialMessages)
  const [conversationId, setConversationId] = useState(initialConversationId)
  const [question, setQuestion] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<StoredCitation | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  // Re-sync when the router swaps to a different conversation. Adjusting
  // state during render is React's recommended alternative to a
  // setState-in-effect, and is the pattern the app shell already uses.
  const [lastConversationId, setLastConversationId] = useState(
    initialConversationId,
  )
  if (initialConversationId !== lastConversationId) {
    setLastConversationId(initialConversationId)
    setMessages(initialMessages)
    setConversationId(initialConversationId)
    setSource(null)
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Escape closes the source panel.
  useEffect(() => {
    if (!source) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSource(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [source])

  const ask = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = question.trim()
    if (text.length === 0 || isStreaming) return

    setError(null)
    setQuestion('')
    setMessages((prev) => [
      ...prev,
      {
        id: `local-user-${Date.now()}`,
        role: 'user',
        content: text,
        citations: [],
        metrics: null,
      },
      {
        id: `local-assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        citations: [],
        metrics: null,
      },
    ])
    setIsStreaming(true)

    const applyToLast = (
      update: (m: ConversationMessage) => ConversationMessage,
    ) => {
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last) next[next.length - 1] = update(last)
        return next
      })
    }

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, conversationId }),
      })
      if (!response.ok || !response.body) {
        const detail = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(detail?.error ?? 'The request failed.')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const raw of lines) {
          if (raw.trim().length === 0) continue
          const event = JSON.parse(raw) as StreamEvent

          if (event.type === 'conversation' && event.conversationId) {
            if (!conversationId) {
              setConversationId(event.conversationId)
              // Adopt the new thread's URL without a navigation, so the
              // in-flight stream and local state survive.
              window.history.replaceState(
                null,
                '',
                `/chat/${event.conversationId}`,
              )
            }
          } else if (event.type === 'citations') {
            applyToLast((m) => ({ ...m, citations: event.citations ?? [] }))
          } else if (event.type === 'token') {
            applyToLast((m) => ({
              ...m,
              content: m.content + (event.value ?? ''),
            }))
          } else if (event.type === 'metrics' && event.metrics) {
            const metrics = event.metrics
            applyToLast((m) => ({ ...m, metrics }))
          } else if (event.type === 'error') {
            setError(event.message ?? 'The answer could not be generated.')
          }
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The request failed.')
    } finally {
      setIsStreaming(false)
      // Refresh so the new conversation (and its title) appears in Recents.
      router.refresh()
    }
  }

  if (!configured) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold">Not configured</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Set <code>NVIDIA_API_KEY</code> to enable document chat. A free key
            is available at build.nvidia.com.
          </p>
        </div>
      </div>
    )
  }

  const composer = (
    <form onSubmit={ask} className="flex w-full items-center gap-2">
      <Input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask about your documents…"
        aria-label="Question"
        disabled={isStreaming}
        className="h-12 rounded-full px-5"
      />
      <Button
        type="submit"
        size="icon"
        className="size-11 shrink-0 rounded-full"
        disabled={isStreaming || question.trim() === ''}
      >
        <Send className="size-4" />
        <span className="sr-only">Send</span>
      </Button>
    </form>
  )

  const isEmpty = messages.length === 0

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {isEmpty ? (
          // Centred greeting + composer, no card and no fixed-height box.
          <div className="flex flex-1 flex-col items-center justify-center px-4">
            <h1 className="mb-8 text-3xl font-semibold tracking-tight">
              Ready when you are.
            </h1>
            <div className="w-full max-w-3xl">
              {error && (
                <div className="mb-3">
                  <FormMessage message={error} />
                </div>
              )}
              {composer}
              <p className="text-muted-foreground mt-4 text-center text-sm">
                {readyDocumentCount === 0 ? (
                  <>
                    No documents indexed yet.{' '}
                    <Link href="/documents" className="underline">
                      Upload a PDF
                    </Link>{' '}
                    to get started.
                  </>
                ) : (
                  <>
                    Answers come only from your {readyDocumentCount} indexed{' '}
                    {readyDocumentCount === 1 ? 'document' : 'documents'}.
                  </>
                )}
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* Full-width shell, readable measure for the text itself. */}
              <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
                {messages.map((message, i) => (
                  <div key={message.id}>
                    {message.role === 'user' ? (
                      <div className="flex justify-end">
                        <div className="bg-muted max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap">
                          {message.content}
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm">
                        {message.content ? (
                          <Markdown>{message.content}</Markdown>
                        ) : (
                          // No text yet: the dots ARE the progress. Once
                          // tokens arrive the streaming text replaces them.
                          isStreaming &&
                          i === messages.length - 1 && <Thinking />
                        )}
                        {message.citations.length > 0 && (
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <span className="text-muted-foreground text-xs">
                              Sources
                            </span>
                            {message.citations.map((citation) => (
                              <button
                                key={citation.chunkId}
                                type="button"
                                onClick={() => setSource(citation)}
                                className="bg-muted hover:bg-accent rounded-full px-2.5 py-1 text-xs transition-colors"
                              >
                                [{citation.index}] {citation.documentTitle} — p
                                {citation.pageNumber}
                              </button>
                            ))}
                          </div>
                        )}
                        {message.metrics && (
                          <p className="text-muted-foreground mt-2 text-xs">
                            {formatMetrics(message.metrics).join(' · ')}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={endRef} />
              </div>
            </div>

            <div className="bg-background/80 sticky bottom-0 backdrop-blur">
              <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)_+_1rem)]">
                {error && (
                  <div className="mb-2">
                    <FormMessage message={error} />
                  </div>
                )}
                {composer}
              </div>
            </div>
          </>
        )}
      </div>

      {source && (
        <aside
          aria-label={`Source: ${source.documentTitle}, page ${source.pageNumber}`}
          className={cn(
            'bg-background flex w-full max-w-full flex-col border-l',
            'fixed inset-0 z-40 md:static md:z-auto md:w-[45%] md:max-w-[720px]',
          )}
        >
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <p className="min-w-0 flex-1 truncate text-sm font-medium">
              {source.documentTitle}{' '}
              <span className="text-muted-foreground font-normal">
                — page {source.pageNumber}
              </span>
            </p>
            <Button asChild size="icon" variant="ghost" className="size-8">
              <a
                href={`/api/documents/${source.documentId}/source#page=${source.pageNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open in new tab"
              >
                <ExternalLink className="size-4" />
              </a>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label="Close source"
              onClick={() => setSource(null)}
            >
              <X className="size-4" />
            </Button>
          </div>
          {/* No `sandbox` attribute: a fully-restrictive sandbox prevents the
              browser's PDF viewer from initialising, and the permissive
              combination that does work (`allow-scripts allow-same-origin`)
              provides no protection at all. The route hardens the response
              instead — see its comment for the threat model. */}
          <iframe
            key={`${source.documentId}#${source.pageNumber}`}
            title={`${source.documentTitle}, page ${source.pageNumber}`}
            src={`/api/documents/${source.documentId}/source#page=${source.pageNumber}`}
            className="min-h-0 flex-1 border-0"
          />
        </aside>
      )}
    </div>
  )
}
