import 'server-only'

import { AI_ENV_KEYS, type AiEnvKey, aiEnvShape } from '@/lib/ai-env'
import { env, type Env } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * The one place the app reads its AI settings (spec 0040 FR6): a value saved
 * from Settings, else the environment variable, else its default.
 *
 * Reads are synchronous — `aiSettings()` layers the saved values, held in
 * memory, over `env`, so a request never waits on the database for them
 * (NFR2). The saved values are loaded by `refreshAiSettings()`, which the
 * entry points (the chat route, the document actions, the eval) await. They
 * are reloaded at most every `TTL_MS`, so a second instance picks up a change
 * made on the first, and at once after a save on this one.
 *
 * With nothing saved, every value is exactly `env`'s (NFR1). Until the first
 * refresh in a process — as in unit tests — nothing is loaded and nothing is
 * fetched.
 */

export type AiSettings = Pick<Env, AiEnvKey>
export type AiSettingKey = AiEnvKey

/**
 * Settings that belong to a connection (the endpoint and its key). They are
 * resolved here like the rest, but never saved as plain rows: API keys are
 * stored encrypted with their connection (#54).
 */
const CONNECTION_KEYS = new Set<AiSettingKey>([
  'NVIDIA_API_KEY',
  'RAG_LLM_BASE_URL',
])

/** The keys Settings may save. */
export const SAVABLE_KEYS: readonly AiSettingKey[] = AI_ENV_KEYS.filter(
  (k) => !CONNECTION_KEYS.has(k),
)

export const TTL_MS = 30_000

interface Loaded {
  /** Parsed saved values, already validated. */
  saved: Partial<AiSettings>
  /**
   * `saved` over `env`, built once per load since reads sit on hot paths.
   * Null when nothing is saved: then reads go straight to `env`.
   */
  merged: AiSettings | null
  loadedAt: number
}

let state: Loaded | null = null
let inflight: Promise<void> | null = null

function isSavable(key: string): key is AiSettingKey {
  return (SAVABLE_KEYS as readonly string[]).includes(key)
}

/**
 * Parse `raw` exactly as the environment variable would be. Returns the
 * value, or the first validation message.
 */
export function parseSetting(
  key: AiSettingKey,
  raw: string,
):
  { ok: true; value: AiSettings[AiSettingKey] } | { ok: false; error: string } {
  const result = aiEnvShape[key].safeParse(raw)
  if (result.success) {
    return { ok: true, value: result.data as AiSettings[AiSettingKey] }
  }
  return {
    ok: false,
    error: result.error.issues[0]?.message ?? 'Invalid value',
  }
}

/** The rules that span two settings, as `env.ts` applies them at boot. */
function crossFieldError(s: AiSettings): string | null {
  if (s.RAG_CHUNK_OVERLAP_TOKENS >= s.RAG_CHUNK_TOKENS) {
    return 'RAG_CHUNK_OVERLAP_TOKENS must be smaller than RAG_CHUNK_TOKENS'
  }
  return null
}

function fromEnv(): AiSettings {
  const out = {} as Record<AiSettingKey, unknown>
  for (const key of AI_ENV_KEYS) out[key] = env[key]
  return out as AiSettings
}

function merge(saved: Partial<AiSettings>): AiSettings {
  return { ...fromEnv(), ...saved }
}

function mergedOrNull(saved: Partial<AiSettings>): AiSettings | null {
  return Object.keys(saved).length > 0 ? merge(saved) : null
}

/** The settings in force: saved → env → default. */
export function aiSettings(): AiSettings {
  if (!state) return fromEnv()
  if (Date.now() - state.loadedAt > TTL_MS) void refreshAiSettings()
  return state.merged ?? fromEnv()
}

/** Validate the saved rows; a row that no longer parses is skipped, loudly. */
function parseRows(
  rows: { key: string; value: string }[],
): Partial<AiSettings> {
  const saved: Partial<Record<AiSettingKey, unknown>> = {}
  for (const row of rows) {
    if (!isSavable(row.key)) {
      logger.warn('ai-settings: ignoring unknown saved key', { key: row.key })
      continue
    }
    const parsed = parseSetting(row.key, row.value)
    if (!parsed.ok) {
      logger.warn('ai-settings: ignoring invalid saved value', {
        key: row.key,
        error: parsed.error,
      })
      continue
    }
    saved[row.key] = parsed.value
  }
  const typed = saved as Partial<AiSettings>
  const error = crossFieldError(merge(typed))
  if (error) {
    logger.warn('ai-settings: ignoring saved chunk sizes', { error })
    delete typed.RAG_CHUNK_TOKENS
    delete typed.RAG_CHUNK_OVERLAP_TOKENS
  }
  return typed
}

/**
 * Load the saved values if they are older than the TTL (or `force`). Never
 * throws: if the database is unreachable the last good values — or the
 * environment, before any load — stay in force, and the next try waits a TTL.
 */
export function refreshAiSettings({
  force = false,
}: { force?: boolean } = {}): Promise<void> {
  if (!force && state && Date.now() - state.loadedAt <= TTL_MS) {
    return Promise.resolve()
  }
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const { readSavedRows } = await import('./store')
      const saved = parseRows(await readSavedRows())
      state = { saved, merged: mergedOrNull(saved), loadedAt: Date.now() }
    } catch (err) {
      logger.error('ai-settings: could not load saved settings', { err })
      const saved = state?.saved ?? {}
      state = { saved, merged: mergedOrNull(saved), loadedAt: Date.now() }
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Save one setting, validated as its environment variable would be and
 * against the settings it depends on, then reload so it applies to the next
 * request. The caller checks who may do this (FR7).
 */
export async function saveAiSetting(
  key: string,
  raw: string,
  userId: string | null,
): Promise<SaveResult> {
  if (!isSavable(key)) {
    return { ok: false, error: `${key} cannot be saved as a setting` }
  }
  const parsed = parseSetting(key, raw)
  if (!parsed.ok) return parsed
  await refreshAiSettings()
  const error = crossFieldError({ ...aiSettings(), [key]: parsed.value })
  if (error) return { ok: false, error }
  const { writeSavedRow } = await import('./store')
  await writeSavedRow(key, raw, userId)
  await refreshAiSettings({ force: true })
  return { ok: true }
}

/** Remove a saved value, so the environment (or default) applies again. */
export async function resetAiSetting(key: string): Promise<SaveResult> {
  if (!isSavable(key)) {
    return { ok: false, error: `${key} cannot be saved as a setting` }
  }
  const { deleteSavedRow } = await import('./store')
  await deleteSavedRow(key)
  await refreshAiSettings({ force: true })
  return { ok: true }
}

/** Forget everything loaded. Tests only. */
export function __resetAiSettingsForTests(): void {
  state = null
  inflight = null
}
