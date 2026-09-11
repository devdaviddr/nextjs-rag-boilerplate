'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Send } from 'lucide-react'

import { FormMessage } from '@/components/auth/field-error'
import { Markdown } from '@/components/chat/markdown'
import { SourceViewer } from '@/components/chat/source-viewer'
import { Thinking } from '@/components/chat/thinking'
import { CreateKnowledgeBaseDialog } from '@/components/rag/create-knowledge-base-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { StoredCitation, StoredMetrics } from '@/db/schema'
import type { ConversationMessage } from '@/lib/chat/actions'
import { formatMetrics } from '@/lib/chat/metrics'
import type { KnowledgeBaseSummary } from '@/lib/rag/kb-actions'

/**
 * The chat surface (spec 0026), now knowledge-base scoped (spec 0028).
 *
 * Empty, it is a centred greeting with the composer beneath it. On the first
 * message it becomes a scrolling transcript with a pinned composer — in place,
 * without a navigation, so nothing flashes and the stream is never interrupted.
 */

interface StreamEvent {
  type:
    | 'conversation'
    | 'citations'
    | 'token'
    | 'metrics'
    | 'done'
    | 'error'
    | 'step'
    | 'revision'
  conversationId?: string
  title?: string
  citations?: StoredCitation[]
  metrics?: StoredMetrics
  value?: string
  message?: string
  phase?: string
  iteration?: number
  stripped?: number[]
}

/**
 * Human wording for an agentic phase (spec 0029 FR7).
 *
 * Unknown phases fall back to no label rather than showing a raw identifier —
 * a new server phase should degrade to plain dots, not leak its internal name.
 */
function phaseLabel(phase?: string, iteration?: number): string | undefined {
  switch (phase) {
    case 'rewriting':
      return 'Understanding your question…'
    case 'routing':
      return 'Deciding where to look…'
    case 'searching':
      return iteration && iteration > 1
        ? `Searching your documents (${iteration})…`
        : 'Searching your documents…'
    case 'drafting':
      return 'Writing the answer…'
    case 'verifying':
      return 'Checking sources…'
    default:
      return undefined
  }
}

// The composer's selection. `'all'` is the untouched default — "everything I
// own", tracking new knowledge bases as they're created. The moment a user
// touches an individual checkbox it becomes an explicit array, because from
// then on "all" and "everything currently owned" are no longer the same
// question. An empty array is a real, distinct state (spec 0028 NFR3) — never
// collapsed back into `'all'`.
type Selection = 'all' | string[]

function selectedIdsFor(
  selection: Selection,
  knowledgeBases: KnowledgeBaseSummary[],
): string[] {
  return selection === 'all' ? knowledgeBases.map((kb) => kb.id) : selection
}

/** The composer trigger's summary — the exact three shapes spec 0028 calls for. */
function summariseSelection(
  selection: Selection,
  knowledgeBases: KnowledgeBaseSummary[],
): string {
  const ids = selectedIdsFor(selection, knowledgeBases)
  if (ids.length === 0) return 'No knowledge base selected'
  if (selection === 'all' || ids.length === knowledgeBases.length) {
    return 'All knowledge bases'
  }
  const names = knowledgeBases
    .filter((kb) => ids.includes(kb.id))
    .map((kb) => kb.name)
  return `${ids.length} selected: ${names.join(', ')}`
}

/** The read-only label for a conversation whose scope is already fixed. */
function describeFixedScope(
  ids: string[],
  knowledgeBases: KnowledgeBaseSummary[],
): string {
  if (ids.length === 0) {
    return 'No knowledge base selected for this conversation.'
  }
  const names = knowledgeBases
    .filter((kb) => ids.includes(kb.id))
    .map((kb) => kb.name)
  if (names.length === knowledgeBases.length) {
    return 'Searching all knowledge bases.'
  }
  return `Searching ${names.join(', ')}.`
}

export function ChatView({
  configured,
  knowledgeBases: initialKnowledgeBases,
  conversationId: initialConversationId,
  knowledgeBaseIds: initialKnowledgeBaseIds,
  initialMessages,
}: {
  configured: boolean
  knowledgeBases: KnowledgeBaseSummary[]
  conversationId?: string
  /** Present only for an existing conversation — its scope, fixed at creation. */
  knowledgeBaseIds?: string[]
  initialMessages: ConversationMessage[]
}) {
  const router = useRouter()
  const [messages, setMessages] =
    useState<ConversationMessage[]>(initialMessages)
  const [conversationId, setConversationId] = useState(initialConversationId)
  const [question, setQuestion] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [phase, setPhase] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<StoredCitation | null>(null)
  const [knowledgeBases, setKnowledgeBases] = useState(initialKnowledgeBases)
  const [selection, setSelection] = useState<Selection>('all')
  const [createOpen, setCreateOpen] = useState(false)
  // The scope actually locked in for THIS conversation, once one exists —
  // either handed down from the server (an existing thread) or captured the
  // moment this session creates one. Once set, the picker becomes read-only:
  // a thread's scope is fixed at creation (spec 0028, "Out of scope").
  const [lockedKbIds, setLockedKbIds] = useState<string[] | undefined>(
    initialKnowledgeBaseIds,
  )
  const endRef = useRef<HTMLDivElement>(null)
  /**
   * Monotonic id for each ask(), so a finishing request can tell whether it is
   * still the newest one.
   *
   * `router.refresh()` below re-renders the server tree, and doing that while a
   * NEWER request is streaming aborts it — the server sees `ResponseAborted`
   * and the answer is lost. Measured directly: the planner call for question 2
   * died with `errorName: ResponseAborted, aborted: true`, caused by question
   * 1's refresh. Refresh is only needed so Recents picks up the new thread, and
   * that can always wait for the last request to finish.
   */
  const requestSeq = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Re-sync when the router swaps to a different conversation. Adjusting
  // state during render is React's recommended alternative to a
  // setState-in-effect, and is the pattern the app shell already uses.
  //
  // `lastConversationId` must also be advanced when THIS view adopts a new
  // thread mid-stream (see the 'conversation' frame below). Without that, the
  // `router.refresh()` at the end of a request re-fetches props for the URL
  // just adopted via replaceState, `initialConversationId` arrives as the new
  // id, it does not match the `undefined` this view mounted with, and the
  // branch below fires — wiping messages, including one the user has already
  // sent. The server persists that message; the DOM simply never shows it.
  const [lastConversationId, setLastConversationId] = useState(
    initialConversationId,
  )
  if (initialConversationId !== lastConversationId) {
    setLastConversationId(initialConversationId)
    setMessages(initialMessages)
    setConversationId(initialConversationId)
    setLockedKbIds(initialKnowledgeBaseIds)
    setSelection('all')
    setSource(null)
  }

  /**
   * Adopt a newer server payload for the SAME conversation.
   *
   * The block above only re-syncs when the thread changes, so a
   * `router.refresh()` that brings messages the client does not have — the
   * answer just persisted, or one sent from another tab — was rendered by the
   * server and then ignored here.
   *
   * Guarded on `isStreaming`: mid-stream the client is ahead of the database
   * by design (the optimistic question, the partial answer), and adopting the
   * server's shorter list would wipe what the user is watching arrive.
   */
  const [lastInitialMessages, setLastInitialMessages] =
    useState(initialMessages)
  if (initialMessages !== lastInitialMessages) {
    setLastInitialMessages(initialMessages)
    if (!isStreaming && initialMessages.length > messages.length) {
      setMessages(initialMessages)
    }
  }

  /**
   * Re-fetch the thread when this view mounts on an existing conversation.
   *
   * Next's client Router Cache keeps the RSC payload for a route, and a BACK
   * navigation restores that entry verbatim — `staleTimes` does not apply to
   * it. So the sequence "ask a question, get an answer, navigate away, come
   * back" replayed the payload captured BEFORE the answer existed: the
   * messages were in the database the whole time and the transcript rendered
   * without them until a hard refresh.
   *
   * `router.refresh()` here is safe in a way it is not elsewhere in this file
   * (see `requestSeq`): a mount cannot be mid-stream, so there is no in-flight
   * request for it to tear down.
   */
  useEffect(() => {
    if (initialConversationId) router.refresh()
    // Mount only. Re-running on every id change would refresh immediately
    // after a navigation that has just fetched this data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Stable, so the source panel's Escape handler is not torn down and
  // reattached on every render of the transcript.
  const closeSource = useCallback(() => setSource(null), [])

  const hasFixedScope = lockedKbIds !== undefined
  const selectedIds = selectedIdsFor(selection, knowledgeBases)

  const toggleKb = (id: string) => {
    setSelection((prev) => {
      const current = selectedIdsFor(prev, knowledgeBases)
      return current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id]
    })
  }

  const ask = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = question.trim()
    // A user with no knowledge bases at all cannot send — not a refusal
    // round-tripped through the server, which is a strictly worse version of
    // the same guarantee (spec 0028 UX). A deliberately empty SELECTION among
    // existing knowledge bases is allowed through; the API short-circuits it
    // before any embedding call.
    if (text.length === 0 || isStreaming || knowledgeBases.length === 0) return

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
    setPhase(undefined)
    const seq = ++requestSeq.current
    // A refresh queued by an earlier answer must not land during this one.
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }

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

    // Captured now, before any response arrives: this is the scope that will
    // end up locked in if this call creates a new conversation.
    const isCreating = !conversationId
    const requestedKbIds = selection === 'all' ? undefined : selection

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: text,
          conversationId,
          // Only meaningful when creating — an existing thread's scope is
          // fixed and the API ignores this field for it (spec 0028).
          ...(isCreating ? { knowledgeBaseIds: requestedKbIds } : {}),
        }),
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
              // Deliberately NOT advancing `lastConversationId` here.
              //
              // It mirrors the PROP, and the prop is undefined on /chat. Setting
              // it to the new id made `initialConversationId !== lastConversationId`
              // permanently true, so the "router swapped threads" branch fired on
              // the very next render and reset `messages` to the server's copy —
              // empty. Measured: the thinking indicator vanished at 520ms and the
              // screen stayed blank for the remaining ~29s.
              // Adopt the new thread's URL without a navigation, so the
              // in-flight stream and local state survive.
              //
              // This was briefly deferred to the end of the stream, on the
              // theory that it was remounting the component. It was not — the
              // remount came from advancing `lastConversationId` here, which
              // made the re-sync branch fire and wipe `messages`. Deferring it
              // also pushed the URL and Recents update behind citation
              // verification, which is another model call: the answer was
              // readable for 5-15s while the sidebar still showed nothing.
              window.history.replaceState(
                null,
                '',
                `/chat/${event.conversationId}`,
              )
              // The scope is locked in the instant the thread exists — the
              // picker below switches to a read-only label from here on.
              setLockedKbIds(selectedIdsFor(selection, knowledgeBases))
            }
          } else if (event.type === 'revision' && event.value !== undefined) {
            // Citation verification removed a claim its source did not support
            // (spec 0029 FR6). Replace the streamed text with the verified
            // version — this is what gets persisted, so the thread is
            // consistent when reopened.
            const verified = event.value
            setMessages((prev) => {
              const next = [...prev]
              const last = next.length - 1
              if (last >= 0 && next[last]) {
                next[last] = { ...next[last], content: verified }
              }
              return next
            })
          } else if (event.type === 'step') {
            setPhase(phaseLabel(event.phase, event.iteration))
          } else if (event.type === 'citations') {
            applyToLast((m) => ({ ...m, citations: event.citations ?? [] }))
          } else if (event.type === 'token') {
            // Prose has started; the text is now its own progress indicator.
            // React bails out when the value is unchanged, so calling this on
            // every token costs nothing after the first.
            setPhase(undefined)
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
      setPhase(undefined)
      // Refresh so the new conversation (and its title) appears in Recents.
      //
      // Deferred and re-checked, not fired immediately. `router.refresh()`
      // re-renders the server tree, and when that lands mid-stream it tears
      // down the in-flight request — the server sees `ResponseAborted` and the
      // answer is lost. Measured: question 2's planner call died with
      // `errorName: ResponseAborted, aborted: true`.
      //
      // The delay is not the guarantee (the fetch is async and could still
      // land late); the seq check at fire time is, and `ask()` cancels a
      // pending timer outright. Recents being a moment stale is invisible;
      // losing an answer is not.
      if (seq === requestSeq.current) {
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null
          if (seq === requestSeq.current) router.refresh()
        }, 400)
      }
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

  // Above the composer: an editable multi-select for a new conversation, or a
  // small read-only label once the scope is fixed (spec 0028 UX items 4/5).
  const scopeControl = hasFixedScope ? (
    <p className="text-muted-foreground mb-2 text-center text-xs sm:text-left">
      {describeFixedScope(lockedKbIds ?? [], knowledgeBases)}
    </p>
  ) : (
    knowledgeBases.length > 0 && (
      <div className="mb-2 flex justify-center sm:justify-start">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-w-[80vw] justify-between gap-1 rounded-full sm:max-w-xs"
            >
              <span className="truncate">
                {summariseSelection(selection, knowledgeBases)}
              </span>
              <ChevronDown className="size-3.5 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {knowledgeBases.map((kb) => (
              <DropdownMenuCheckboxItem
                key={kb.id}
                checked={selectedIds.includes(kb.id)}
                onCheckedChange={() => toggleKb(kb.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {kb.name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  )

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
        disabled={
          isStreaming || question.trim() === '' || knowledgeBases.length === 0
        }
      >
        <Send className="size-4" />
        <span className="sr-only">Send</span>
      </Button>
    </form>
  )

  const isEmpty = messages.length === 0

  // Ready-document count scoped to what's actually selected, not the whole
  // account — the point of a knowledge base is that not everything is always
  // in scope (spec 0028).
  const selectedReadyCount = knowledgeBases
    .filter((kb) => selectedIds.includes(kb.id))
    .reduce((sum, kb) => sum + kb.readyCount, 0)

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
              {scopeControl}
              {composer}
              {knowledgeBases.length === 0 ? (
                // Zero knowledge bases: Send stays disabled above rather than
                // letting the request go and come back with a canned refusal
                // — a strictly worse version of a guarantee the server
                // already enforces (spec 0028 UX).
                <div className="mt-4 flex flex-col items-center gap-3">
                  <p className="text-muted-foreground text-center text-sm">
                    Create a knowledge base to start asking questions about your
                    documents.
                  </p>
                  <Button type="button" onClick={() => setCreateOpen(true)}>
                    New knowledge base
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground mt-4 text-center text-sm">
                  {selectedIds.length === 0 ? (
                    <>
                      No knowledge base selected — choose one above to ask a
                      question.
                    </>
                  ) : (
                    <>
                      Answers come only from your {selectedReadyCount} indexed{' '}
                      {selectedReadyCount === 1 ? 'document' : 'documents'}.
                    </>
                  )}
                </p>
              )}
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
                          i === messages.length - 1 && (
                            <Thinking label={phase} />
                          )
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
                {scopeControl}
                {composer}
              </div>
            </div>
          </>
        )}
      </div>

      {source && (
        // Keyed by chunk, so switching citations remounts rather than trying
        // to reconcile a half-loaded page image with a new one's boxes.
        <SourceViewer
          key={source.chunkId}
          citation={source}
          onClose={closeSource}
        />
      )}

      <CreateKnowledgeBaseDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(kb) => {
          setKnowledgeBases((prev) => [...prev, kb])
          router.refresh()
        }}
      />
    </div>
  )
}
