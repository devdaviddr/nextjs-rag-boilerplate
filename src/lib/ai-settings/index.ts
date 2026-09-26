import 'server-only'

import { AI_ENV_KEYS, type AiEnvKey, aiEnvShape } from '@/lib/ai-env'
import { env, type Env } from '@/lib/env'
import { logger } from '@/lib/logger'

import { decryptSecret } from './crypto'
import { type PresetId, presetForUrl } from './presets'
import type { AuditWrite } from './store'

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

/**
 * The jobs the app sends to a model (spec 0040 FR2). Each has a model
 * setting; all but embeddings can also be pointed at a saved connection.
 * The reranker's `llm` backend is the planner's job.
 */
export const AI_ROLES = [
  'chat',
  'planner',
  'hyde',
  'vision',
  'parse',
  'embed',
] as const
export type AiRole = (typeof AI_ROLES)[number]

export const ROLE_MODEL_KEY = {
  chat: 'RAG_CHAT_MODEL',
  planner: 'RAG_PLANNER_MODEL',
  hyde: 'RAG_HYDE_MODEL',
  vision: 'RAG_VISION_MODEL',
  parse: 'RAG_PARSE_MODEL',
  embed: 'RAG_EMBED_MODEL',
} as const satisfies Record<AiRole, AiSettingKey>

/**
 * Embeddings stay on the `.env` endpoint for now: the index holds one
 * model's vectors, and moving it is a re-index (FR3, #56).
 */
export const CONNECTABLE_ROLES = [
  'chat',
  'planner',
  'hyde',
  'vision',
  'parse',
] as const satisfies readonly AiRole[]
export type ConnectableRole = (typeof CONNECTABLE_ROLES)[number]

/** The `.env` endpoint, always available and never stored. */
export const ENV_CONNECTION_ID = 'env'

const ROLE_KEY_PREFIX = 'connection:'

/** An endpoint as the server uses it: the key decrypted, in memory only. */
export interface ResolvedConnection {
  id: string
  name: string
  preset: PresetId
  baseUrl: string
  apiKey: string | undefined
  /** A key was saved but cannot be decrypted (the secret changed). */
  keyUnreadable: boolean
}

export interface ConnectionRow {
  id: string
  name: string
  preset: string
  baseUrl: string
  apiKeyCiphertext: string | null
}

/** Who saved a value and when (spec 0040 FR5). */
export interface SavedMeta {
  by: string | null
  at: string | null
}

interface Loaded {
  /** Parsed saved values, already validated. */
  saved: Partial<AiSettings>
  /** Who saved each row and when, by key (settings and `connection:<job>`). */
  savedMeta: Map<string, SavedMeta>
  /** Saved connections, by id. */
  connections: Map<string, ResolvedConnection>
  /** Which saved connection each job uses; absent means `.env`. */
  roleConnection: Partial<Record<ConnectableRole, string>>
  /**
   * `saved` over `env`, built once per load since reads sit on hot paths.
   * Null when nothing is saved: then reads go straight to `env`.
   */
  merged: AiSettings | null
  loadedAt: number
}

let state: Loaded | null = null
let inflight: Promise<void> | null = null

function isConnectableRole(role: string): role is ConnectableRole {
  return (CONNECTABLE_ROLES as readonly string[]).includes(role)
}

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
  rows: {
    key: string
    value: string
    updatedBy?: string | null
    updatedAt?: Date | null
  }[],
): {
  saved: Partial<AiSettings>
  savedMeta: Map<string, SavedMeta>
  roleConnection: Partial<Record<ConnectableRole, string>>
} {
  const saved: Partial<Record<AiSettingKey, unknown>> = {}
  const savedMeta = new Map<string, SavedMeta>()
  const roleConnection: Partial<Record<ConnectableRole, string>> = {}
  for (const row of rows) {
    savedMeta.set(row.key, {
      by: row.updatedBy ?? null,
      at: row.updatedAt ? row.updatedAt.toISOString() : null,
    })
    if (row.key.startsWith(ROLE_KEY_PREFIX)) {
      const role = row.key.slice(ROLE_KEY_PREFIX.length)
      if (isConnectableRole(role)) roleConnection[role] = row.value
      continue
    }
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
  return { saved: typed, savedMeta, roleConnection }
}

function resolveRows(rows: ConnectionRow[]): Map<string, ResolvedConnection> {
  const out = new Map<string, ResolvedConnection>()
  for (const row of rows) {
    const apiKey = row.apiKeyCiphertext
      ? decryptSecret(row.apiKeyCiphertext)
      : null
    if (row.apiKeyCiphertext && apiKey === null) {
      logger.warn('ai-settings: a saved API key cannot be decrypted', {
        connection: row.id,
      })
    }
    out.set(row.id, {
      id: row.id,
      name: row.name,
      preset: row.preset as PresetId,
      baseUrl: row.baseUrl,
      apiKey: apiKey ?? undefined,
      keyUnreadable: Boolean(row.apiKeyCiphertext) && apiKey === null,
    })
  }
  return out
}

/** The `.env` endpoint as a connection. */
export function envConnection(): ResolvedConnection {
  const s = fromEnv()
  return {
    id: ENV_CONNECTION_ID,
    name: 'Environment (.env)',
    preset: presetForUrl(s.RAG_LLM_BASE_URL),
    baseUrl: s.RAG_LLM_BASE_URL,
    apiKey: s.NVIDIA_API_KEY,
    keyUnreadable: false,
  }
}

/** Saved connections, in no particular order. Server only: keys included. */
export function savedConnections(): ResolvedConnection[] {
  return [...(state?.connections.values() ?? [])]
}

/** The connection id a job uses: a saved one, or `.env`. */
export function connectionIdFor(role: AiRole): string {
  if (!isConnectableRole(role)) return ENV_CONNECTION_ID
  const id = state?.roleConnection[role]
  return id && state?.connections.has(id) ? id : ENV_CONNECTION_ID
}

/** Where a job's requests go. A saved connection that was deleted falls back to `.env`. */
export function connectionFor(role: AiRole): ResolvedConnection {
  const id = connectionIdFor(role)
  return id === ENV_CONNECTION_ID
    ? envConnection()
    : (state?.connections.get(id) ?? envConnection())
}

/** The model a job uses. */
export function modelFor(role: AiRole): string {
  return aiSettings()[ROLE_MODEL_KEY[role]]
}

/** Who saved `key` and when, or null when it is not saved (FR5). */
export function savedMetaFor(key: string): SavedMeta | null {
  return savedKeys().has(key) ? (state?.savedMeta.get(key) ?? null) : null
}

/** The value in force for a setting, as the page shows it. */
export function displayValue(key: AiSettingKey): string {
  return String(aiSettings()[key])
}

/** The keys with a saved value, for "saved" / "env" / "default" badges. */
export function savedKeys(): Set<string> {
  const keys = new Set<string>(Object.keys(state?.saved ?? {}))
  for (const role of Object.keys(state?.roleConnection ?? {})) {
    keys.add(ROLE_KEY_PREFIX + role)
  }
  return keys
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
      const { readSavedRows, readConnectionRows } = await import('./store')
      const [rows, connectionRows] = await Promise.all([
        readSavedRows(),
        readConnectionRows(),
      ])
      const { saved, savedMeta, roleConnection } = parseRows(rows)
      state = {
        saved,
        savedMeta,
        connections: resolveRows(connectionRows),
        roleConnection,
        merged: mergedOrNull(saved),
        loadedAt: Date.now(),
      }
    } catch (err) {
      logger.error('ai-settings: could not load saved settings', { err })
      const saved = state?.saved ?? {}
      state = {
        saved,
        savedMeta: state?.savedMeta ?? new Map(),
        connections: state?.connections ?? new Map(),
        roleConnection: state?.roleConnection ?? {},
        merged: mergedOrNull(saved),
        loadedAt: Date.now(),
      }
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/** Record one change (spec 0040 FR5). Never given a secret. */
export async function auditChange(
  entry: AuditWrite,
  userId: string | null,
): Promise<void> {
  const { writeAudit } = await import('./store')
  await writeAudit(entry, userId)
}

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
  const before = displayValue(key)
  const { writeSavedRow } = await import('./store')
  await writeSavedRow(key, raw, userId)
  await refreshAiSettings({ force: true })
  const after = displayValue(key)
  if (after !== before) {
    await auditChange(
      { action: 'save', key, oldValue: before, newValue: after },
      userId,
    )
  }
  return { ok: true }
}

/** Remove a saved value, so the environment (or default) applies again. */
export async function resetAiSetting(
  key: string,
  userId: string | null = null,
): Promise<SaveResult> {
  if (!isSavable(key)) {
    return { ok: false, error: `${key} cannot be saved as a setting` }
  }
  await refreshAiSettings()
  const wasSaved = savedKeys().has(key)
  const before = displayValue(key)
  const { deleteSavedRow } = await import('./store')
  await deleteSavedRow(key)
  await refreshAiSettings({ force: true })
  if (wasSaved) {
    await auditChange(
      { action: 'reset', key, oldValue: before, newValue: displayValue(key) },
      userId,
    )
  }
  return { ok: true }
}

/** A connection's name for the audit log; `.env` for the built-in one. */
function connectionName(id: string): string {
  return id === ENV_CONNECTION_ID
    ? envConnection().name
    : (state?.connections.get(id)?.name ?? id)
}

/**
 * Point a job at a connection (or back at `.env`). The connection must
 * exist; embeddings cannot be moved here (#56).
 */
export async function saveRoleConnection(
  role: string,
  connectionId: string,
  userId: string | null,
): Promise<SaveResult> {
  if (!isConnectableRole(role)) {
    return { ok: false, error: `The ${role} job cannot change connection` }
  }
  const store = await import('./store')
  await refreshAiSettings({ force: true })
  const before = connectionIdFor(role)
  const beforeName = connectionName(before)
  if (connectionId === ENV_CONNECTION_ID) {
    await store.deleteSavedRow(ROLE_KEY_PREFIX + role)
  } else {
    if (!state?.connections.has(connectionId)) {
      return { ok: false, error: 'That connection no longer exists' }
    }
    await store.writeSavedRow(ROLE_KEY_PREFIX + role, connectionId, userId)
  }
  await refreshAiSettings({ force: true })
  if (before !== connectionId) {
    await auditChange(
      {
        action: connectionId === ENV_CONNECTION_ID ? 'reset' : 'save',
        key: ROLE_KEY_PREFIX + role,
        oldValue: beforeName,
        newValue: connectionName(connectionId),
      },
      userId,
    )
  }
  return { ok: true }
}

/** Forget everything loaded. Tests only. */
export function __resetAiSettingsForTests(): void {
  state = null
  inflight = null
}
