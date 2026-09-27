/**
 * How the client talks to a model provider (spec 0045).
 *
 * The app speaks one format, OpenAI's chat completions: the bodies the client
 * builds, the responses the planner and verifier read, and the SSE frames the
 * answer path parses (`parseStreamFrame`). An adapter translates that format
 * to its provider's and back, so the RAG code never sees a wire format.
 *
 * The transport — retries, deadlines, the NIM 404 rules — stays in the
 * client's one `post()`, shared by every adapter (NFR2). The OpenAI-compatible
 * adapter translates nothing, which is what keeps an existing deployment's
 * requests exactly as they were (NFR1).
 */

/** An OpenAI chat-completions request body, as the client builds it. */
export interface OpenAiChatBody {
  model: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant'
    content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'image_url'; image_url: { url: string } }
        >
  }>
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: unknown[]
  tool_choice?: unknown
  [extra: string]: unknown
}

/** An OpenAI chat-completions response, the parts the app reads. */
export interface OpenAiChatResponse {
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }> | null
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export interface ProviderAdapter {
  /** Headers that carry the key, and any the provider requires. */
  authHeaders(key: string | undefined): Record<string, string>
  /** Where to send a chat request, and the provider's body for it. */
  chatRequest(body: OpenAiChatBody): { path: string; body: unknown }
  /** The provider's chat response, as OpenAI's. */
  chatResponse(json: unknown): OpenAiChatResponse
  /** The provider's streamed answer, as OpenAI SSE frames. */
  chatStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>
  /** Whether the provider has an embeddings API at all. */
  embeddings: boolean
}
