import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * #48 — the composer unlocks when the answer is complete (`metrics`), not when
 * the stream closes after citation verification. Once it can unlock early, a
 * second question can be in flight while the first is still verifying, so
 * every stream event must land on ITS answer, and an older stream finishing
 * must not unlock the composer under a newer one.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/components/rag/create-knowledge-base-dialog', () => ({
  CreateKnowledgeBaseDialog: () => null,
}))

import { ChatView } from '@/components/chat/chat-view'

// jsdom has no layout, so no scrollIntoView; the view auto-scrolls on update.
Element.prototype.scrollIntoView = vi.fn()

/** A response body the test writes NDJSON frames into, one call at a time. */
function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const enc = new TextEncoder()
  return {
    response: new Response(body, { status: 200 }),
    send: (frame: unknown) =>
      controller.enqueue(enc.encode(`${JSON.stringify(frame)}\n`)),
    close: () => controller.close(),
  }
}

const metrics = {
  model: 'test-chat',
  promptTokens: 10,
  completionTokens: 5,
  timeToFirstTokenMs: 100,
  totalMs: 300,
  tokensPerSecond: 20,
  sourceCount: 1,
  retrieval: 'agentic',
}

const citation = {
  index: 1,
  chunkId: 'c1',
  documentId: 'd1',
  documentTitle: 'Guide',
  pageNumber: 1,
  similarity: 0.6,
}

function setup() {
  const streams = [controlledStream(), controlledStream()]
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => streams[call++]!.response),
  )
  render(
    <ChatView
      configured
      knowledgeBases={[
        {
          id: 'kb1',
          name: 'KB',
          description: null,
          documentCount: 1,
          readyCount: 1,
          createdAt: new Date(),
        },
      ]}
      initialMessages={[]}
    />,
  )
  // Re-queried every time: the composer moves (centre while the thread is
  // empty, bottom once it has messages), so a held reference goes stale.
  const composer = () => screen.getByLabelText('Question') as HTMLInputElement
  const ask = async (text: string) => {
    fireEvent.change(composer(), { target: { value: text } })
    await act(async () => {
      fireEvent.submit(composer().closest('form')!)
    })
  }
  return { streams, composer, ask }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ChatView composer (#48)', () => {
  it('unlocks at metrics, before verification finishes', async () => {
    const { streams, composer, ask } = setup()
    await ask('first question')
    const [first] = streams
    await act(async () => {
      first!.send({ type: 'conversation', conversationId: 'conv-1' })
      first!.send({ type: 'citations', citations: [citation] })
      first!.send({ type: 'token', value: 'First answer [1].' })
    })
    expect(composer().disabled).toBe(true)

    await act(async () => {
      first!.send({ type: 'metrics', metrics })
      first!.send({ type: 'step', phase: 'verifying' })
    })
    // The stream is still open (verifying), yet the composer is free.
    await waitFor(() => expect(composer().disabled).toBe(false))
    expect(screen.getByText('Checking sources…')).toBeTruthy()

    await act(async () => {
      first!.send({ type: 'done' })
      first!.close()
    })
    await waitFor(() =>
      expect(screen.queryByText('Checking sources…')).toBeNull(),
    )
  })

  it('applies a late revision to its own answer and keeps the newer one locked', async () => {
    const { streams, composer, ask } = setup()
    const [first, second] = streams
    await ask('first question')
    await act(async () => {
      first!.send({ type: 'conversation', conversationId: 'conv-1' })
      first!.send({ type: 'citations', citations: [citation] })
      first!.send({ type: 'token', value: 'First draft with a claim [1].' })
      first!.send({ type: 'metrics', metrics })
      first!.send({ type: 'step', phase: 'verifying' })
    })
    await waitFor(() => expect(composer().disabled).toBe(false))

    // Second question while the first is still verifying.
    await ask('second question')
    await act(async () => {
      second!.send({ type: 'token', value: 'Second answer streaming' })
    })
    expect(composer().disabled).toBe(true)

    // The first stream's revision and close arrive now.
    await act(async () => {
      first!.send({ type: 'revision', value: 'First answer, verified.' })
      first!.send({ type: 'done' })
      first!.close()
    })

    expect(screen.getByText('First answer, verified.')).toBeTruthy()
    expect(screen.getByText('Second answer streaming')).toBeTruthy()
    expect(screen.queryByText('First draft with a claim [1].')).toBeNull()
    // The older stream closing did not unlock the composer under the newer one.
    expect(composer().disabled).toBe(true)

    await act(async () => {
      second!.send({ type: 'metrics', metrics })
      second!.send({ type: 'done' })
      second!.close()
    })
    await waitFor(() => expect(composer().disabled).toBe(false))
  })
})
