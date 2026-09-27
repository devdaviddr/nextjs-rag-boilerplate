import { anthropicAdapter } from './anthropic'
import { openAiAdapter } from './openai'
import type { ProviderAdapter } from './types'

export type {
  OpenAiChatBody,
  OpenAiChatResponse,
  ProviderAdapter,
} from './types'

/** The adapter for a connection's preset (spec 0045 FR4). */
export function adapterFor(preset: string): ProviderAdapter {
  return preset === 'anthropic' ? anthropicAdapter : openAiAdapter
}
