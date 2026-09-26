/**
 * The providers Settings knows how to talk to (spec 0040 FR1, FR9). Every
 * one speaks the OpenAI-compatible API; a preset fills in the URL, says
 * whether a key is needed, and carries the hint shown when a test fails.
 *
 * Plain data, safe to import from the browser.
 */

export type PresetId =
  | 'nvidia-nim'
  | 'openrouter'
  | 'llama-cpp'
  | 'openai'
  | 'ollama'
  | 'vllm'
  | 'custom'

export interface Preset {
  id: PresetId
  label: string
  /** Filled into the form; `<host>` is for the admin to replace. */
  baseUrl: string
  keyRequired: boolean
  note: string
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyRequired: true,
    note: 'Keys from build.nvidia.com. The free tier allows about 40 requests a minute.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    note: 'Hundreds of models behind one key. Not every model supports tool calls, which the planner needs.',
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp server',
    baseUrl: 'http://<host>:8080/v1',
    keyRequired: false,
    note: 'One model per llama-server. The planner needs --jinja and a model whose template supports tools. From inside Docker, use the host’s LAN address or host.docker.internal, not localhost.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    note: 'Chat models only for now: OpenAI embeddings are not 2048-dimensional (#64).',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://<host>:11434/v1',
    keyRequired: false,
    note: 'From inside Docker, use the host’s LAN address or host.docker.internal, not localhost.',
  },
  {
    id: 'vllm',
    label: 'vLLM / LM Studio',
    baseUrl: 'http://<host>:8000/v1',
    keyRequired: false,
    note: 'LM Studio listens on port 1234 by default.',
  },
  {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    keyRequired: false,
    note: 'Any OpenAI-compatible endpoint.',
  },
]

/**
 * Headers a provider wants besides the API key (spec 0040 FR9). OpenRouter's
 * attribution headers are optional; with them the app shows up by name in
 * the key owner's OpenRouter activity instead of as an unnamed caller.
 */
export function presetHeaders(
  preset: string,
  app: { url: string; name: string },
): Record<string, string> {
  return preset === 'openrouter'
    ? { 'HTTP-Referer': app.url, 'X-Title': app.name }
    : {}
}

/** A model as a connection's `/models` describes it, where it says more. */
export interface ModelDetail {
  contextLength?: number
  /** US dollars per million prompt tokens (OpenRouter lists a price). */
  promptPerMillion?: number
}

/** "128k context · $0.15/M" — for the model picker. */
export function describeModel(detail: ModelDetail | undefined): string {
  if (!detail) return ''
  const parts: string[] = []
  if (detail.contextLength) {
    parts.push(
      detail.contextLength >= 1000
        ? `${Math.round(detail.contextLength / 1000)}k context`
        : `${detail.contextLength} context`,
    )
  }
  if (detail.promptPerMillion !== undefined) {
    parts.push(
      detail.promptPerMillion === 0
        ? 'free'
        : `$${detail.promptPerMillion.toFixed(detail.promptPerMillion < 1 ? 2 : 1)}/M`,
    )
  }
  return parts.join(' · ')
}

export function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1]!
}

/** The preset a URL most likely belongs to — for the `.env` connection. */
export function presetForUrl(url: string): PresetId {
  if (url.includes('api.nvidia.com')) return 'nvidia-nim'
  if (url.includes('openrouter.ai')) return 'openrouter'
  if (url.includes('api.openai.com')) return 'openai'
  if (url.includes(':11434')) return 'ollama'
  return 'custom'
}
