import type { OpenAiChatResponse, ProviderAdapter } from './types'

/**
 * Any OpenAI-compatible endpoint: NVIDIA NIM, OpenRouter, OpenAI, llama.cpp,
 * Ollama, vLLM. The app already speaks this format, so nothing is translated
 * (spec 0045 FR2, NFR1).
 */
export const openAiAdapter: ProviderAdapter = {
  authHeaders: (key): Record<string, string> =>
    key ? { Authorization: `Bearer ${key}` } : {},
  chatRequest: (body) => ({ path: '/chat/completions', body }),
  chatResponse: (json) => json as OpenAiChatResponse,
  chatStream: (body) => body,
  embeddings: true,
}
