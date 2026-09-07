'use client'

import { useEffect, useRef, useState } from 'react'
import { MessagesSquare, Send } from 'lucide-react'
import Link from 'next/link'

import { FormMessage } from '@/components/auth/field-error'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'

export interface Citation {
  index: number
  chunkId: string
  documentId: string
  documentTitle: string
  pageNumber: number
  similarity: number
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
}

interface ChatPanelProps {
  configured: boolean
  readyDocumentCount: number
}

export function ChatPanel({ configured, readyDocumentCount }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [question, setQuestion] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const ask = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = question.trim()
    if (text.length === 0 || isStreaming) return

    setError(null)
    setQuestion('')
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '', citations: [] },
    ])
    setIsStreaming(true)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text }),
      })

      if (!response.ok || !response.body) {
        const detail = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(detail?.error ?? 'The request failed.')
      }

      // NDJSON: one JSON object per line. Buffer across chunk boundaries.
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const applyToLast = (update: (message: Message) => Message) => {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last) next[next.length - 1] = update(last)
          return next
        })
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const raw of lines) {
          if (raw.trim().length === 0) continue
          const event = JSON.parse(raw) as
            | { type: 'citations'; citations: Citation[] }
            | { type: 'token'; value: string }
            | { type: 'done' }
            | { type: 'error'; message: string }

          if (event.type === 'citations') {
            applyToLast((m) => ({ ...m, citations: event.citations }))
          } else if (event.type === 'token') {
            applyToLast((m) => ({ ...m, content: m.content + event.value }))
          } else if (event.type === 'error') {
            setError(event.message)
          }
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The request failed.')
    } finally {
      setIsStreaming(false)
    }
  }

  if (!configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Not configured</CardTitle>
          <CardDescription>
            Set NVIDIA_API_KEY to enable document chat. A free key is available
            at build.nvidia.com.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className="flex h-[70vh] flex-col">
      <CardContent className="flex-1 space-y-4 overflow-y-auto pt-6">
        {messages.length === 0 && (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-center text-sm">
            <MessagesSquare className="size-8 opacity-50" />
            {readyDocumentCount === 0 ? (
              <p>
                No documents are indexed yet.{' '}
                <Link href="/documents" className="underline">
                  Upload a PDF
                </Link>{' '}
                to start asking questions.
              </p>
            ) : (
              <p>
                Ask a question about your {readyDocumentCount} indexed{' '}
                {readyDocumentCount === 1 ? 'document' : 'documents'}.
              </p>
            )}
          </div>
        )}

        {messages.map((message, i) => (
          <div
            key={i}
            className={
              message.role === 'user'
                ? 'flex justify-end'
                : 'flex justify-start'
            }
          >
            <div
              className={
                message.role === 'user'
                  ? 'bg-primary text-primary-foreground max-w-[80%] rounded-lg px-3 py-2 text-sm'
                  : 'bg-muted max-w-[80%] space-y-2 rounded-lg px-3 py-2 text-sm'
              }
            >
              <p className="whitespace-pre-wrap">
                {message.content ||
                  (isStreaming && i === messages.length - 1 ? '…' : '')}
              </p>

              {message.role === 'assistant' &&
                message.citations &&
                message.citations.length > 0 && (
                  <div className="border-border/60 space-y-1 border-t pt-2">
                    <p className="text-muted-foreground text-xs font-medium">
                      Sources
                    </p>
                    {message.citations.map((citation) => (
                      <p key={citation.chunkId} className="text-xs">
                        <span className="text-muted-foreground">
                          [{citation.index}]
                        </span>{' '}
                        {citation.documentTitle} — page {citation.pageNumber}
                      </p>
                    ))}
                  </div>
                )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </CardContent>

      <div className="border-t p-4">
        {error && (
          <div className="mb-2">
            <FormMessage message={error} />
          </div>
        )}
        <form onSubmit={ask} className="flex gap-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about your documents…"
            aria-label="Question"
            disabled={isStreaming}
          />
          <Button
            type="submit"
            disabled={isStreaming || question.trim() === ''}
          >
            <Send className="size-4" />
            <span className="sr-only">Send</span>
          </Button>
        </form>
      </div>
    </Card>
  )
}
