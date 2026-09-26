---
id: 0040
title: Configure the AI provider and models from Settings
status: Proposed
release: '—'
created: 2026-09-25
updated: 2026-09-25
---

# 0040 — Configure the AI provider and models from Settings

Tracked in [#51](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/51):
[#53](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/53) (foundation),
[#54](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/54),
[#55](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/55),
[#56](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/56),
[#57](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/57),
[#58](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/58),
[#67](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/67) (provider
presets).

## Summary

Let an admin choose the inference provider, the model for each job, and the
retrieval and answering settings from **Settings**, applied on the next request
without editing `.env` or restarting. Environment variables keep working and
remain the defaults; a saved setting overrides them, and a deployment can lock
the page so configuration stays in code.

## Problem / motivation

Every AI setting is an environment variable parsed once at boot
(`src/lib/env.ts`, 37 `RAG_*` / `NVIDIA_*` keys) and read directly in 16 files.
Changing anything — pointing at a different provider, trying another chat
model, turning reranking on — means editing `.env` and restarting or
redeploying. On 2026-09-25 that cost was real: the planner model
(`nemotron-3.5-lightning`) was down for hours, and the only way to switch
planner, or turn the agentic path off, was a redeploy.

The Settings page today shows the user's account and the build (two cards).

Changing provider is possible today only for everything at once:
`RAG_LLM_BASE_URL` points every job at one OpenAI-compatible endpoint, whose key
lives in the misleadingly named `NVIDIA_API_KEY`. So you cannot, for example,
answer through OpenRouter while embedding on NVIDIA NIM, or run chat on a
llama.cpp server in the house.

## Goals

- Point the app at any OpenAI-compatible endpoint: NVIDIA NIM, OpenAI, a local
  Ollama / vLLM / LM Studio server, or a custom URL.
- Choose the connection and model per job: chat, planner, embeddings, HyDE,
  vision, parse.
- Change retrieval and answering settings (toggles and limits) safely.
- Keep `.env` configuration fully supported, and lockable.

## Non-goals

- Non-OpenAI-compatible APIs (Anthropic's native Messages API, Azure OpenAI
  deployment URLs with `api-key` headers). A provider adapter layer is future
  work.
- Per-user or per-knowledge-base model choices. Settings are instance-wide.
- Settings outside AI (upload quotas, auth, email) — a later spec if wanted.

## Requirements

### Functional

- **FR1 — Connections.** An admin can add, edit, test and remove one or more
  _connections_: name, preset (NVIDIA NIM, OpenRouter, llama.cpp, OpenAI,
  Ollama, vLLM/LM Studio, Custom), base URL, API key. The key is encrypted at rest and never returned to the
  browser. **Test** calls `GET {base}/models`.
- **FR2 — Model roles.** Chat, planner, HyDE, vision and parse each select a
  connection and a model. The model picker is filled from the connection's
  `/models`, with free text allowed. **Test** sends a 3-token completion and
  reports latency.
- **FR3 — Embeddings.** The embedding role also checks the model returns 2048
  dimensions (the `halfvec(2048)` column). Saving a new embedding model re-embeds
  every ready document through the resumable ingestion path (spec 0034), shows
  progress, and keeps queries on the old model until the swap completes.
- **FR4 — Retrieval and answering.** Toggles: agentic, rerank (backend, local
  model), parent assembly, HyDE, cracking, read-figure. Numbers: top-k, minimum
  similarity, hybrid candidates, RRF k, loop searches / ms / tokens, rerank
  candidates, chunk tokens / overlap. Each is validated by the same bounds as
  `src/lib/env.ts`; settings that only affect new uploads say so and offer
  re-ingest.
- **FR5 — Provenance, reset, audit, lock.** Each setting shows its source:
  _default_, _env_ or _saved_ (who, when). **Reset** removes the saved value.
  Every save is audited (old → new, secrets redacted). `AI_SETTINGS_LOCKED=true`
  makes the AI sections read-only in the UI and in the server actions.
- **FR6 — Runtime resolution.** A single server-side resolver,
  `getAiSettings()`, applies _saved → env → default_ and replaces every direct
  `env.RAG_*` / `env.NVIDIA_API_KEY` read (app, chat route, eval). It is cached
  in-process, invalidated on save, with a short TTL so another instance catches
  up.
- **FR7 — Access.** Only admins can see or change the AI sections; the server
  actions call `requireRole('admin')`. Other roles see one read-only line under
  About: the active chat model and provider name, never a URL or key.
- **FR8 — Layout.** Settings is split into sections: **Account · AI provider ·
  Models · Retrieval & answering · About** (build info).
- **FR9 — Provider presets.** Each preset knows its provider's behaviour (see
  _Provider presets_): default URL, whether a key is required, extra headers,
  and how models are listed. Per-role tests check what each job needs — chat
  streams, the planner can call tools, embeddings return the expected
  dimension — and a failure says what to change (for llama.cpp: start
  `llama-server` with `--jinja` or `--embeddings`). An existing `.env`
  deployment appears as a NIM connection with no setup.

### Non-functional

- **NFR1** — With nothing saved, behaviour is byte-identical to today: the unit
  suite passes unchanged, and `pnpm rag:eval` matches the current baseline with
  refusal accuracy **1.000**.
- **NFR2** — No measurable per-request cost: settings resolve from memory, not
  a query per call.
- **NFR3** — Secrets never leave the server: not in responses, logs, the audit
  log or client bundles.

## Design / approach

**Storage.** Two tables (one migration): `ai_connections` (id, name, preset,
base_url, api_key_ciphertext, created/updated by/at) and `ai_settings` (key,
value jsonb, updated_by, updated_at), plus `ai_settings_audit`. Keys are
encrypted with AES-256-GCM under a key derived from `AUTH_SECRET` via HKDF
(info `ai-settings/v1`), or from `SETTINGS_ENCRYPTION_KEY` when set. Rotating
that secret invalidates saved keys; the page says so and asks for them again.

**Provider presets.**

| Preset                     | Base URL                              | Key                   | Notes                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NVIDIA NIM                 | `https://integrate.api.nvidia.com/v1` | required              | Today's default; seeded from `RAG_LLM_BASE_URL` + `NVIDIA_API_KEY`. Free tier ~40 requests/min.                                                                                                                                                                                                                                                                                 |
| OpenRouter                 | `https://openrouter.ai/api/v1`        | required              | Optional `HTTP-Referer` / `X-Title` attribution headers. `/models` lists hundreds of models, so the picker is searchable and shows context length and price. Streams may carry `:` keep-alive comments (already ignored) and error frames (handled since #43). Embeddings availability varies; the embeddings test decides.                                                     |
| llama.cpp (`llama-server`) | e.g. `http://<host>:8080/v1`          | only with `--api-key` | One model per server process: the picker shows the loaded model, and chat and embeddings are normally two connections (two servers). Tool calling (the planner) needs `--jinja` and a model whose chat template supports tools; `/v1/embeddings` needs `--embeddings`. From inside Docker, `localhost` is the container — use the host's LAN address or `host.docker.internal`. |
| OpenAI                     | `https://api.openai.com/v1`           | required              | Embedding models are 1536/3072 dimensions — not usable for embeddings until #64.                                                                                                                                                                                                                                                                                                |
| Ollama                     | `http://<host>:11434/v1`              | none                  | Common embedding models are 768 dimensions (#64).                                                                                                                                                                                                                                                                                                                               |
| vLLM / LM Studio           | `http://<host>:8000/v1` / `:1234/v1`  | optional              |                                                                                                                                                                                                                                                                                                                                                                                 |
| Custom                     | any                                   | optional              | Any OpenAI-compatible endpoint.                                                                                                                                                                                                                                                                                                                                                 |

**Resolution.** `src/lib/ai-settings.ts` (server-only) exports
`getAiSettings()`, returning one typed object shaped like today's `env` subset.
The zod schema in `env.ts` is split so the same field definitions validate env,
saved values and form input. Callers change from `env.RAG_CHAT_MODEL` to
`(await getAiSettings()).chatModel`. The inference client takes a connection
(base URL + key) per call instead of reading `RAG_LLM_BASE_URL` /
`NVIDIA_API_KEY` globally.

**Embeddings swap.** Store `embedding_model` on each chunk row (or an index
generation number). Retrieval filters to the active generation, so a half-done
re-index never compares vectors from two models. The new model's vectors are
written alongside, and the active generation flips when every document has
them. Old rows are deleted after the flip.

**UI.** `settings-client.tsx` gains section navigation. The AI sections are
server components that load the resolved settings and render forms posting to
server actions. Each field shows its source badge and help text lifted from
`.env.example`.

**What a reviewer must not get wrong.** Refusal accuracy rests on
`RAG_MIN_SIMILARITY` being calibrated for one embedding model. FR3 changes the
model, and FR4 exposes the floor itself. The page must show the calibrated
default next to the floor, and the eval must be run after an embedding switch.

## Acceptance criteria

- [x] FR1: connections can be added, tested and removed; the key appears in no
      response (tested) — `tests/unit/ai-settings-actions.test.ts` _"FR1 / NFR3"_,
      e2e `tests/e2e/settings-ai.spec.ts` checks every response body
- [x] FR2: a changed role applies to the next request without restart — the
      client resolves `connectionFor(role)` / `modelFor(role)` per call; a save
      reloads at once (`tests/unit/ai-settings.test.ts` _"connections"_); tried
      live 2026-09-25: chat, planner (tool call) and embeddings tests pass on NIM
- [ ] FR3: a wrong-dimension model is rejected; after a switch every document
      re-embeds and retrieval never mixes generations; eval refusal 1.000
- [x] FR4: every listed setting applies on the next request; out-of-range values
      are rejected with the allowed range — `saveRetrievalSetting` saves through
      `saveAiSetting`, which reloads at once; `ai-settings-actions.test.ts`
      _"FR4"_ (range messages), `ai-settings-retrieval.test.ts` (every stated
      range equals its variable's), e2e `settings-ai.spec.ts` _"tunes a
      retrieval setting"_
- [x] FR5: source badges, reset, audit (secrets redacted), and
      `AI_SETTINGS_LOCKED` enforced server-side — `ai-settings-actions.test.ts`
      _"FR5"_ (audit without the key, who saved it, every write refused when
      locked), `ai-settings.test.ts` (save and reset audited old → new)
- [x] FR6: no direct `env.RAG_*` reads remain outside the resolver (lint rule or
      grep check in CI) — `no-restricted-syntax` in `eslint.config.mjs`, run by
      `pnpm lint` in CI; resolver behaviour in `tests/unit/ai-settings.test.ts`
- [x] FR7: non-admins get 403 from every AI settings action — each returns
      _"Only admins can change AI settings."_ before touching anything
      (`ai-settings-actions.test.ts` _"FR7"_); the page renders the AI sections
      for admins only
- [ ] FR9: chat and planner through OpenRouter with embeddings on NIM, and
      chat on a llama.cpp server, both work; a llama.cpp planner without tool
      support fails its test with the `--jinja` hint; an existing `.env`
      deployment shows its NIM connection unchanged
- [x] NFR1: with nothing saved, `pnpm rag:eval` equals the baseline — run
      2026-09-25 on #53: hit@1 0.941, hit@3 0.941, MRR 0.941, refusal 1.000,
      cross-KB leakage 0, identical to `eval/results/baseline.json`; the 821
      existing unit tests pass unchanged

### As built: the resolver (#53)

`src/lib/ai-settings` is the resolver, with three differences from the design
above.

- **Reads are synchronous.** `aiSettings()` returns the saved values, held in
  memory, laid over `env`, so the 17 callers changed from `env.RAG_X` to
  `aiSettings().RAG_X` and none of them became async. `refreshAiSettings()`
  loads the table at most every 30 seconds; the chat route, the document
  actions and the eval await it first, and a stale read starts a reload in the
  background. A save reloads at once. If the database is down the last good
  values stay in force.
- **Keys keep their environment names, and values are strings.** A row is
  `RAG_TOP_K = "5"`, parsed by the same zod field as the variable (now in
  `src/lib/ai-env.ts`, spread into `env.ts`), so a saved value cannot mean
  something the variable would not. The one rule across fields (chunk overlap
  below chunk size) is checked on save and on load. One table, `ai_settings`
  (text value); the audit table comes with FR5 (#58).
- **Connection settings are not stored.** `NVIDIA_API_KEY` and
  `RAG_LLM_BASE_URL` resolve through `aiSettings()` like the rest, but cannot
  be saved as rows: they belong to encrypted connections (FR1, #54).

With nothing saved, `aiSettings()` reads `env` directly, so behaviour is the
environment's exactly.

### As built: connections and jobs (#54, #55)

- **Connections** live in `ai_connections`; the key is AES-256-GCM under an
  HKDF key from `SETTINGS_ENCRYPTION_KEY` or `AUTH_SECRET`
  (`src/lib/ai-settings/crypto.ts`), with its last four characters kept for
  display. The `.env` endpoint is not a row: it is the built-in "Environment"
  connection, read-only on the page, which is what an existing deployment sees
  with no setup (FR9).
- **Jobs** are chat, planner, HyDE, vision, parse and embed. Each call site
  names its job (`createChatCompletion(…, { role: 'planner' })`) and the
  client resolves the connection and model, so a saved change applies to the
  next request. Which connection a job uses is an `ai_settings` row,
  `connection:<job>`; a deleted connection falls back to `.env`.
- **Embeddings cannot move yet.** Their connection is fixed to `.env` and
  their model is read-only until FR3's re-index exists (#56); a different
  model's vectors would not be comparable with the index.
- **Tests** send what the app sends: the planner test uses the real planner
  prompt and search tool with an 800-token budget (it is a reasoning model;
  a 3-token probe never reaches the tool call), and retries once on a 429 or
  5xx. Only status, latency and model ids reach the browser.
- **FR8**: AI provider and Models were then merged into one **Configuration**
  tab (spec 0042 FR1); Retrieval & answering joins it with #57. A **Users**
  section holds the existing user admin. Sections are tabs
  down the side (a scrolling row on phones), one shown at a time, with the
  open one in the URL hash so `/settings#models` links straight to it.
- **The model picker** is a searchable dropdown of the connection's
  `/models`, fetched once per connection and shared by every job; any name
  can still be typed, since not every server lists all it serves.

### As built: retrieval, provenance and providers (#57, #58, #67)

- **Retrieval & answering** is a third block in the Configuration tab, not a
  tab of its own. The settings it offers, their labels and ranges are listed in
  `src/lib/ai-settings/retrieval-fields.ts`; a test holds each stated range to
  its zod field, which still decides. Beyond the FR4 list it includes the
  spec 0043 knobs (when to plan, planner call limit, planner reasoning, early
  stop) and the whole-document passage limit. There is no re-ingest action yet,
  so passage size and cracking say they affect new uploads and that a document
  is re-indexed by uploading it again.
- **Audit** is one table, `ai_settings_audit`: save, reset, a job's connection
  and connection add / edit / remove, old → new as the page shows it. A
  connection is recorded as `preset · URL · key ••••1a2b`. The latest 20 are
  listed under Recent changes.
- **`AI_SETTINGS_LOCKED`** lives in `env.ts`, not `ai-env.ts`, so the page can
  never save or unlock it. Tests still run while locked; every changing action
  refuses.
- **Providers (FR9)**: OpenRouter requests carry `HTTP-Referer` (`APP_URL`) and
  `X-Title` (the app name), from the app and from Settings' tests. The picker
  shows context length and prompt price where `/models` lists them. The chat
  test streams, and fails if the endpoint does not. An embeddings test that
  gets a 404 or 501 suggests `--embeddings` for llama.cpp.

## Security & privacy

- API keys: encrypted at rest, write-only in the UI, redacted in logs and audit.
- Admin-only server actions; the page is not the only gate.
- Third-party providers (OpenRouter, a remote llama.cpp) receive the question
  and the retrieved passages. The connection form says so; choosing a provider
  is choosing who sees document text.
- A connection URL is an SSRF vector: an admin could point it at an internal
  host. Admins are trusted in this template, but the **Test** action should not
  return the response body, only status, latency and the model list.
- `AI_SETTINGS_LOCKED` for deployments that want config only in code.

## Alternatives considered

- **Edit `.env` from the UI and restart.** Needs file-system writes and a
  restart path in the container. Fragile, and breaks the image's immutability.
- **One global provider for every job.** Simpler, but it blocks common set-ups
  like embeddings on NIM with chat on a local model.
- **Per-user settings.** A different product; instance-wide is what the
  boilerplate needs.

## Decisions (reviewed 2026-09-25)

1. **A saved setting overrides the env var.** Otherwise the page could change
   nothing on a deployment that already sets those variables.
   `AI_SETTINGS_LOCKED=true` makes the page read-only for deployments that keep
   config in code (FR5).
2. **The encryption key derives from `AUTH_SECRET`** (HKDF), overridable with an
   optional `SETTINGS_ENCRYPTION_KEY`. Rotating whichever is in use means
   re-entering the saved API keys; the page says so.
3. **v1 keeps the 2048-dimension embedding limit** (FR3). Chat, planner and the
   other roles can move to any provider in v1; embeddings in practice stay on a
   2048-dimension model. Supporting other sizes is tracked separately in
   [#64](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/64).
4. **Non-admins see a read-only line under About** — the active chat model and
   provider name, never URLs or keys (FR7).

## Out of scope / future

- Embedding models of other sizes (#64).
- Provider adapters for non-OpenAI-compatible APIs.
- Non-AI settings (quotas, auth, email).
- Import/export of settings.
- Per-knowledge-base model overrides.

## References

- `src/lib/env.ts`, `.env.example` — every setting and its bounds today
- Specs 0034 (resumable ingestion), 0036 (reranking), 0033 (retrieval knobs)
- #17 (agentic default), #32 / #41 (planner outage) — the incident that shows
  why runtime switching matters
