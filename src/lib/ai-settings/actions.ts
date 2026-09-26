'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { z } from 'zod'

import { ForbiddenError, requireRole } from '@/lib/auth/rbac'
import { getCurrentSession } from '@/lib/auth/session'
import { env as appEnv } from '@/lib/env'
import { logger } from '@/lib/logger'

import {
  AI_ROLES,
  type AiRole,
  CONNECTABLE_ROLES,
  ENV_CONNECTION_ID,
  activeEmbedding,
  ROLE_MODEL_KEY,
  type ResolvedConnection,
  type SavedMeta,
  auditChange,
  connectionFor,
  connectionIdFor,
  envConnection,
  modelFor,
  refreshAiSettings,
  resetAiSetting,
  saveAiSetting,
  saveRoleConnection,
  savedConnections,
  savedKeys,
  savedMetaFor,
  displayValue,
} from './index'
import { PLANNER_SYSTEM_PROMPT } from '@/lib/rag/agentic-run'
import type { ReindexView } from '@/lib/rag/generations'
import { SEARCH_TOOL } from '@/lib/rag/planner'

import { encryptSecret, secretHint } from './crypto'
import { APP_NAME } from '@/lib/brand'

import {
  type ModelDetail,
  PRESETS,
  type PresetId,
  presetById,
  presetForUrl,
  presetHeaders,
} from './presets'
import {
  RETRIEVAL_FIELDS,
  describeRange,
  retrievalField,
} from './retrieval-fields'

/**
 * Settings → AI provider and Models (spec 0040 FR1, FR2, FR7). Every action
 * is admin-only, checked here and not only by the page. API keys go in and
 * never come back out: views carry `••••1a2b` at most (NFR3).
 */

export type ActionResult<T = null> =
  { ok: true; data: T } | { ok: false; error: string }

export interface ConnectionView {
  id: string
  name: string
  preset: PresetId
  baseUrl: string
  /** `••••1a2b`, `set` for a short key, or null for none. */
  keyHint: string | null
  keyUnreadable: boolean
  /** The `.env` endpoint: read-only here. */
  builtIn: boolean
  /** Jobs currently using it. */
  usedBy: AiRole[]
}

export type Source = 'saved' | 'env' | 'default'

export interface RoleView {
  role: AiRole
  connectionId: string
  canChangeConnection: boolean
  model: string
  source: Source
  /** Who last saved this job's model or connection, and when (FR5). */
  saved: SavedMeta | null
}

/** One line of the audit log as the page shows it (FR5). No secrets. */
export interface ChangeView {
  at: string
  by: string | null
  action: string
  key: string
  oldValue: string | null
  newValue: string | null
}

/** One Retrieval & answering setting as the page shows it (FR4, FR5). */
export interface FieldView {
  key: string
  /** The value in force, as it would be written in `.env`. */
  value: string
  source: Source
  saved: SavedMeta | null
}

export interface AiSettingsView {
  connections: ConnectionView[]
  roles: RoleView[]
  retrieval: FieldView[]
  /** The embedding index: its model, and a re-index in progress (#56). */
  reindex: ReindexView
  /** `AI_SETTINGS_LOCKED`: shown, never changed (FR5). */
  locked: boolean
  recentChanges: ChangeView[]
}

export interface TestResult {
  status: number
  latencyMs: number
  /** Model ids the endpoint lists, sorted; empty when it lists none. */
  models: string[]
  /** Context length and price, where the endpoint lists them (OpenRouter). */
  details: Record<string, ModelDetail>
}

export interface ModelsView {
  models: string[]
  details: Record<string, ModelDetail>
}

const FORBIDDEN = 'Only admins can change AI settings.'
const LOCKED =
  'AI settings are locked on this deployment (AI_SETTINGS_LOCKED). Change them in .env.'

/** How many audit lines the page shows. */
const RECENT_CHANGES = 20

async function adminUserId(): Promise<string | null> {
  await requireRole('admin')
  const session = await getCurrentSession()
  return session?.user.id ?? null
}

/** Run an admin action, turning a missing role into a returned error. */
async function asAdmin<T>(
  run: (userId: string | null) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await run(await adminUserId())
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: FORBIDDEN }
    throw err
  }
}

/**
 * An admin action that changes something. Refused whole when the deployment
 * locks its AI settings (FR5): the page greys out, but this is the gate.
 */
async function asAdminWrite<T>(
  run: (userId: string | null) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  return asAdmin(async (userId) => {
    if (appEnv.AI_SETTINGS_LOCKED) return { ok: false, error: LOCKED }
    return run(userId)
  })
}

/** The later of two saves, for a job whose model and connection are two rows. */
function latest(a: SavedMeta | null, b: SavedMeta | null): SavedMeta | null {
  if (!a) return b
  if (!b) return a
  return (a.at ?? '') >= (b.at ?? '') ? a : b
}

function sourceOf(key: string): Source {
  if (savedKeys().has(key)) return 'saved'
  const raw = process.env[key]
  return raw !== undefined && raw !== '' ? 'env' : 'default'
}

function keyHint(c: ResolvedConnection, stored: string | null): string | null {
  if (!c.apiKey && !c.keyUnreadable) return null
  return stored ? `••••${stored}` : 'set'
}

function view(): AiSettingsView {
  const usedBy = (id: string) =>
    AI_ROLES.filter((r) => connectionIdFor(r) === id)
  const env = envConnection()
  const hintOf = (c: ResolvedConnection) =>
    c.id === ENV_CONNECTION_ID
      ? c.apiKey
        ? secretHint(c.apiKey)
        : null
      : (hints.get(c.id) ?? null)
  const connections = [env, ...savedConnections()].map((c) => ({
    id: c.id,
    name: c.name,
    preset: c.preset,
    baseUrl: c.baseUrl,
    keyHint: keyHint(c, hintOf(c)),
    keyUnreadable: c.keyUnreadable,
    builtIn: c.id === ENV_CONNECTION_ID,
    usedBy: usedBy(c.id),
  }))
  const roles = AI_ROLES.map((role) => ({
    role,
    connectionId: connectionIdFor(role),
    canChangeConnection: (CONNECTABLE_ROLES as readonly string[]).includes(
      role,
    ),
    model: modelFor(role),
    source: sourceOf(ROLE_MODEL_KEY[role]),
    saved: latest(
      savedMetaFor(ROLE_MODEL_KEY[role]),
      savedMetaFor(`connection:${role}`),
    ),
  }))
  const retrieval = RETRIEVAL_FIELDS.map((f) => ({
    key: f.key,
    value: displayValue(f.key),
    source: sourceOf(f.key),
    saved: savedMetaFor(f.key),
  }))
  return {
    connections,
    roles,
    retrieval,
    reindex,
    locked: Boolean(appEnv.AI_SETTINGS_LOCKED),
    recentChanges: changes,
  }
}

/** The embedding index's state, refreshed with the view. */
let reindex: ReindexView = {
  activeModel: '',
  activeDimensions: 0,
  building: null,
}

async function loadReindex(): Promise<void> {
  const { reindexView } = await import('@/lib/rag/generations')
  reindex = await reindexView()
}

/** The audit log's latest lines, refreshed with the view. */
let changes: ChangeView[] = []

async function loadChanges(): Promise<void> {
  const { readRecentAudit } = await import('./store')
  changes = (await readRecentAudit(RECENT_CHANGES)).map((row) => ({
    ...row,
    at: row.at.toISOString(),
  }))
}

/** Key hints by connection id, refreshed with the view. */
let hints = new Map<string, string | null>()

async function loadHints(): Promise<void> {
  const { readConnectionRows } = await import('./store')
  hints = new Map((await readConnectionRows()).map((r) => [r.id, r.apiKeyHint]))
}

/** Everything the AI sections show. Admin only. */
export async function getAiSettingsView(): Promise<
  ActionResult<AiSettingsView>
> {
  return asAdmin(async () => {
    await refreshAiSettings({ force: true })
    await loadHints()
    await loadChanges()
    await loadReindex()
    return { ok: true, data: view() }
  })
}

const connectionInput = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, 'Give the connection a name').max(60),
  preset: z.enum(PRESETS.map((p) => p.id) as [PresetId, ...PresetId[]]),
  baseUrl: z
    .string()
    .trim()
    .url('Enter the full base URL, e.g. https://integrate.api.nvidia.com/v1')
    .refine((u) => /^https?:\/\//.test(u), 'The URL must start with http(s)://')
    .refine(
      (u) => !u.includes('<host>'),
      'Replace <host> with the server address',
    ),
  /** Blank on an edit keeps the saved key. */
  apiKey: z.string().trim().max(1000).optional(),
  /** Remove the saved key (for a server that needs none). */
  clearKey: z.boolean().optional(),
})

export type ConnectionInput = z.input<typeof connectionInput>

/** A connection as the audit log records it: never the key, only its hint. */
function describeConnection(c: {
  preset: string
  baseUrl: string
  keyHint: string | null
}): string {
  const key = c.keyHint ? `key ••••${c.keyHint}` : 'no key'
  return `${presetById(c.preset).label} · ${c.baseUrl} · ${key}`
}

export async function saveConnection(
  input: ConnectionInput,
): Promise<ActionResult<{ id: string }>> {
  return asAdminWrite(async (userId) => {
    const parsed = connectionInput.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? 'Check the form',
      }
    }
    const { id, name, preset, baseUrl, apiKey, clearKey } = parsed.data
    const key = apiKey
      ? { ciphertext: encryptSecret(apiKey), hint: secretHint(apiKey) }
      : clearKey
        ? null
        : undefined
    const store = await import('./store')
    const values = {
      name,
      preset,
      baseUrl: baseUrl.replace(/\/$/, ''),
      apiKey: key,
    }
    const previous = id
      ? (await store.readConnectionRows()).find((r) => r.id === id)
      : undefined

    if (id) {
      if (id === ENV_CONNECTION_ID) {
        return { ok: false, error: 'The .env connection is edited in .env' }
      }
      if (!(await store.updateConnection(id, values))) {
        return { ok: false, error: 'That connection no longer exists' }
      }
    } else if (presetById(preset).keyRequired && !apiKey) {
      return {
        ok: false,
        error: `${presetById(preset).label} needs an API key`,
      }
    }
    const savedId = id ?? (await store.insertConnection(values, userId))
    const after = describeConnection({
      preset,
      baseUrl: values.baseUrl,
      keyHint:
        key === undefined
          ? (previous?.apiKeyHint ?? null)
          : (key?.hint ?? null),
    })
    const before = previous
      ? describeConnection({
          preset: previous.preset,
          baseUrl: previous.baseUrl,
          keyHint: previous.apiKeyHint,
        })
      : null
    if (before !== after || previous?.name !== name) {
      await auditChange(
        {
          action: id ? 'connection-edit' : 'connection-add',
          key: name,
          oldValue: before,
          newValue: after,
        },
        userId,
      )
    }
    await refreshAiSettings({ force: true })
    logger.info('ai-settings: connection saved', { id: savedId, preset })
    revalidatePath('/settings')
    return { ok: true, data: { id: savedId } }
  })
}

export async function deleteConnection(id: string): Promise<ActionResult> {
  return asAdminWrite(async (userId) => {
    if (id === ENV_CONNECTION_ID) {
      return { ok: false, error: 'The .env connection cannot be removed' }
    }
    const store = await import('./store')
    const previous = (await store.readConnectionRows()).find((r) => r.id === id)
    await store.deleteConnection(id)
    if (previous) {
      await auditChange(
        {
          action: 'connection-remove',
          key: previous.name,
          oldValue: describeConnection({
            preset: previous.preset,
            baseUrl: previous.baseUrl,
            keyHint: previous.apiKeyHint,
          }),
          newValue: null,
        },
        userId,
      )
    }
    await refreshAiSettings({ force: true })
    logger.info('ai-settings: connection deleted', { id })
    revalidatePath('/settings')
    return { ok: true, data: null }
  })
}

const TEST_TIMEOUT_MS = 15_000

function authHeaders(
  apiKey: string | undefined,
  preset: string,
): Record<string, string> {
  return {
    ...presetHeaders(preset, { url: appEnv.APP_URL, name: APP_NAME }),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

/** Context length and prompt price from one `/models` entry, if listed. */
function detailOf(entry: Record<string, unknown>): ModelDetail | null {
  const context = Number(entry.context_length)
  const pricing = entry.pricing as Record<string, unknown> | undefined
  const prompt = Number(pricing?.prompt)
  const detail: ModelDetail = {}
  if (Number.isFinite(context) && context > 0) detail.contextLength = context
  if (pricing && Number.isFinite(prompt) && prompt >= 0) {
    detail.promptPerMillion = Math.round(prompt * 1_000_000 * 100) / 100
  }
  return Object.keys(detail).length ? detail : null
}

function explain(status: number): string {
  if (status === 401 || status === 403)
    return 'the endpoint refused the API key'
  if (status === 404) return 'nothing answers at that URL; check it ends in /v1'
  if (status === 429) return 'rate limited; try again in a minute'
  if (status >= 500) return 'the endpoint had an error'
  return 'the request failed'
}

/**
 * `GET {base}/models`. Only the status, the time and the model ids come back
 * to the browser, never the body: an admin-supplied URL could point anywhere
 * (spec 0040, Security).
 */
async function listModels(
  baseUrl: string,
  apiKey: string | undefined,
  preset: string,
): Promise<ActionResult<TestResult>> {
  const started = Date.now()
  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { ...authHeaders(apiKey, preset), Accept: 'application/json' },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    return {
      ok: false,
      error: `No response from ${new URL(baseUrl).host} within ${TEST_TIMEOUT_MS / 1000}s. From inside Docker, localhost is the container itself.`,
    }
  }
  const latencyMs = Date.now() - started
  if (!response.ok) {
    return {
      ok: false,
      error: `HTTP ${response.status}: ${explain(response.status)}`,
    }
  }
  let models: string[] = []
  const details: Record<string, ModelDetail> = {}
  try {
    const json = (await response.json()) as {
      data?: Record<string, unknown>[]
    }
    const entries = (json.data ?? [])
      .filter(
        (m): m is Record<string, unknown> & { id: string } =>
          Boolean(m) && typeof m.id === 'string',
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 2000)
    models = entries.map((m) => m.id)
    for (const m of entries) {
      const detail = detailOf(m)
      if (detail) details[m.id] = detail
    }
  } catch {
    // A 200 that is not a model list still proves the URL and key.
  }
  return {
    ok: true,
    data: { status: response.status, latencyMs, models, details },
  }
}

/**
 * Test a connection. For a saved one, the form may carry a new URL or key to
 * try before saving; a blank key means "use the saved key".
 */
export async function testConnection(input: {
  id?: string
  baseUrl?: string
  apiKey?: string
  /** The form's preset, for a connection not saved yet. */
  preset?: string
}): Promise<ActionResult<TestResult>> {
  return asAdmin(async () => {
    await refreshAiSettings()
    const saved =
      input.id === ENV_CONNECTION_ID
        ? envConnection()
        : savedConnections().find((c) => c.id === input.id)
    const baseUrl = input.baseUrl?.trim() || saved?.baseUrl
    if (
      !baseUrl ||
      !/^https?:\/\//.test(baseUrl) ||
      baseUrl.includes('<host>')
    ) {
      return { ok: false, error: 'Enter the full base URL first' }
    }
    return listModels(
      baseUrl,
      input.apiKey?.trim() || saved?.apiKey,
      input.preset ?? saved?.preset ?? presetForUrl(baseUrl),
    )
  })
}

/** The models a connection lists, with any details, for the model picker. */
export async function modelsFor(
  connectionId: string,
): Promise<ActionResult<ModelsView>> {
  const result = await testConnection({ id: connectionId })
  return result.ok
    ? {
        ok: true,
        data: { models: result.data.models, details: result.data.details },
      }
    : result
}

const roleInput = z.object({
  role: z.enum(AI_ROLES),
  connectionId: z.string().min(1),
  model: z.string().trim().min(1, 'Choose a model').max(200),
})

/** Point a job at a connection and a model; applies to the next request. */
export async function saveRole(
  input: z.input<typeof roleInput>,
): Promise<ActionResult> {
  return asAdminWrite(async (userId) => {
    const parsed = roleInput.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? 'Check the form',
      }
    }
    const { role, connectionId, model } = parsed.data
    if (role === 'embed') {
      // The index holds this model's vectors: a new one is a re-index (#56).
      return startReindex(model, userId)
    }
    if (connectionId !== connectionIdFor(role)) {
      const moved = await saveRoleConnection(role, connectionId, userId)
      if (!moved.ok) return moved
    }
    if (model !== modelFor(role)) {
      const saved = await saveAiSetting(ROLE_MODEL_KEY[role], model, userId)
      if (!saved.ok) return saved
    }
    logger.info('ai-settings: job updated', { role, connectionId, model })
    revalidatePath('/settings')
    return { ok: true, data: null }
  })
}

/** Back to `.env` for both the connection and the model. */
export async function resetRole(role: AiRole): Promise<ActionResult> {
  return asAdminWrite(async (userId) => {
    if (!AI_ROLES.includes(role)) return { ok: false, error: 'Unknown job' }
    if ((CONNECTABLE_ROLES as readonly string[]).includes(role)) {
      await saveRoleConnection(role, ENV_CONNECTION_ID, userId)
    }
    await resetAiSetting(ROLE_MODEL_KEY[role], userId)
    revalidatePath('/settings')
    return { ok: true, data: null }
  })
}

export interface RoleTestResult {
  latencyMs: number
  detail: string
}

/** Free-tier reasoning models can take over a minute to plan. */
const ROLE_TEST_TIMEOUT_MS = 90_000

/**
 * Try a job as it is configured now (FR2, FR9): a three-token completion,
 * a tool call for the planner, or one embedding of the right size.
 */
export async function testRole(
  role: AiRole,
): Promise<ActionResult<RoleTestResult>> {
  return asAdmin(async () => {
    if (!AI_ROLES.includes(role)) return { ok: false, error: 'Unknown job' }
    await refreshAiSettings()
    const connection = connectionFor(role)
    if (connection.keyUnreadable) {
      return {
        ok: false,
        error: `The key saved for "${connection.name}" can no longer be read; enter it again.`,
      }
    }
    const model = modelFor(role)
    const base = connection.baseUrl.replace(/\/$/, '')
    // The planner is tested the way the app calls it: its own prompt, the
    // search tool, and room to think first (it is a reasoning model).
    const body =
      role === 'embed'
        ? { input: ['test'], model, input_type: 'query' }
        : role === 'planner'
          ? {
              model,
              messages: [
                { role: 'system', content: PLANNER_SYSTEM_PROMPT },
                {
                  role: 'user',
                  content:
                    'Question: How many days of annual leave do staff get?',
                },
              ],
              tools: [SEARCH_TOOL],
              tool_choice: 'auto',
              max_tokens: 800,
              stream: false,
            }
          : {
              model,
              messages: [{ role: 'user', content: 'Reply with the word OK.' }],
              max_tokens: 3,
              // Chat answers are streamed, so its test streams too (FR9).
              stream: role === 'chat',
            }
    const url = `${base}${role === 'embed' ? '/embeddings' : '/chat/completions'}`
    const started = Date.now()
    let response: Response | null = null
    // One retry on a rate limit or a transient upstream error, as the app's
    // client would, so a free-tier blip does not read as a broken setting.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            ...authHeaders(connection.apiKey, connection.preset),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(ROLE_TEST_TIMEOUT_MS),
          cache: 'no-store',
        })
      } catch {
        return {
          ok: false,
          error: `No response from ${connection.name} within ${ROLE_TEST_TIMEOUT_MS / 1000}s`,
        }
      }
      if (![429, 502, 503, 504].includes(response.status)) break
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (!response) return { ok: false, error: 'No response' }
    const latencyMs = Date.now() - started
    if (!response.ok) {
      const hint =
        role === 'embed' && [404, 501].includes(response.status)
          ? `; for a llama.cpp server, start llama-server with --embeddings`
          : response.status === 404 || response.status === 400
            ? `; is "${model}" available on ${connection.name}?`
            : ''
      return {
        ok: false,
        error: `HTTP ${response.status}: ${explain(response.status)}${hint}`,
      }
    }
    if (role === 'chat') {
      const text = await response.text().catch(() => '')
      if (!/^data:/m.test(text)) {
        return {
          ok: false,
          error:
            'The model answered but did not stream, which chat needs for answers to appear as they are written.',
        }
      }
      return { ok: true, data: { latencyMs, detail: 'streamed an answer' } }
    }
    const json = (await response.json().catch(() => null)) as {
      data?: { embedding?: unknown[] }[]
      choices?: { message?: { tool_calls?: unknown[] } }[]
    } | null
    if (role === 'embed') {
      // The size of the index search reads now (#56).
      const expected = activeEmbedding().dimensions
      const size = json?.data?.[0]?.embedding?.length ?? 0
      if (size !== expected) {
        return {
          ok: false,
          error: `The model returned ${size}-dimensional vectors; the index needs ${expected}.`,
        }
      }
      return { ok: true, data: { latencyMs, detail: `${size} dimensions` } }
    }
    if (
      role === 'planner' &&
      !json?.choices?.[0]?.message?.tool_calls?.length
    ) {
      return {
        ok: false,
        error:
          connection.preset === 'llama-cpp'
            ? 'The model answered but did not call a tool. Start llama-server with --jinja, with a model whose template supports tools.'
            : 'The model answered but did not call a tool, which the planner needs.',
      }
    }
    return {
      ok: true,
      data: {
        latencyMs,
        detail: role === 'planner' ? 'called a tool' : 'answered',
      },
    }
  })
}

/**
 * Save one Retrieval & answering setting (FR4). Parsed by the same zod field
 * as its environment variable; a value it rejects comes back with the range.
 * Applies to the next request.
 */
export async function saveRetrievalSetting(
  key: string,
  raw: string,
): Promise<ActionResult> {
  return asAdminWrite(async (userId) => {
    const field = retrievalField(key)
    if (!field) return { ok: false, error: `${key} is not set here` }
    const value = raw.trim()
    const saved = await saveAiSetting(field.key, value, userId)
    if (!saved.ok) {
      // The cross-setting rule has its own clear message; anything else
      // failed the field's own bounds.
      return {
        ok: false,
        error: saved.error.includes('must be smaller than')
          ? 'The overlap must be smaller than the passage size.'
          : `${field.label} must be ${describeRange(field)}.`,
      }
    }
    logger.info('ai-settings: setting saved', { key, value })
    revalidatePath('/settings')
    return { ok: true, data: null }
  })
}

/** Back to `.env` or the default for one Retrieval & answering setting. */
export async function resetRetrievalSetting(
  key: string,
): Promise<ActionResult> {
  return asAdminWrite(async (userId) => {
    const field = retrievalField(key)
    if (!field) return { ok: false, error: `${key} is not set here` }
    const reset = await resetAiSetting(field.key, userId)
    if (!reset.ok) return reset
    revalidatePath('/settings')
    return { ok: true, data: null }
  })
}

/**
 * Start re-embedding every passage with `model` (spec 0040 FR3, #56). Search
 * stays on the current model until the new index is complete; the build
 * runs after the response, and the recovery sweep resumes it if the process
 * goes away.
 */
async function startReindex(
  model: string,
  userId: string | null,
): Promise<ActionResult> {
  const { startGeneration, buildGeneration } =
    await import('@/lib/rag/generations')
  const before = modelFor('embed')
  const started = await startGeneration(model, userId)
  if (!started.ok) return started
  await auditChange(
    {
      action: 'save',
      key: ROLE_MODEL_KEY.embed,
      oldValue: before,
      newValue: `${model.trim()} (re-indexing ${started.totalChunks} passages, ${started.dimensions} dimensions)`,
    },
    userId,
  )
  after(() => buildGeneration(started.generationId))
  revalidatePath('/settings')
  return { ok: true, data: null }
}

/** Stop a re-index and throw away what it built; search is unaffected. */
export async function cancelReindex(): Promise<ActionResult> {
  return asAdminWrite(async (userId) => {
    const { cancelGeneration, reindexView } =
      await import('@/lib/rag/generations')
    const current = await reindexView()
    if (!current.building) return { ok: false, error: 'No re-index is running' }
    await cancelGeneration(current.building.id)
    await auditChange(
      {
        action: 'reset',
        key: ROLE_MODEL_KEY.embed,
        oldValue: `${current.building.model} (re-index cancelled)`,
        newValue: current.activeModel,
      },
      userId,
    )
    revalidatePath('/settings')
    return { ok: true, data: null }
  })
}
