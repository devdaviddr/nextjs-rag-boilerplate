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
[#58](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/58).

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
  _connections_: name, preset (NIM, OpenAI, Ollama, vLLM/LM Studio, Custom),
  base URL, API key. The key is encrypted at rest and never returned to the
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

- [ ] FR1: connections can be added, tested and removed; the key appears in no
      response (tested)
- [ ] FR2: a changed role applies to the next request without restart
- [ ] FR3: a wrong-dimension model is rejected; after a switch every document
      re-embeds and retrieval never mixes generations; eval refusal 1.000
- [ ] FR4: every listed setting applies on the next request; out-of-range values
      are rejected with the allowed range
- [ ] FR5: source badges, reset, audit (secrets redacted), and
      `AI_SETTINGS_LOCKED` enforced server-side
- [ ] FR6: no direct `env.RAG_*` reads remain outside the resolver (lint rule or
      grep check in CI)
- [ ] FR7: non-admins get 403 from every AI settings action
- [ ] NFR1: with nothing saved, `pnpm rag:eval` equals the baseline

## Security & privacy

- API keys: encrypted at rest, write-only in the UI, redacted in logs and audit.
- Admin-only server actions; the page is not the only gate.
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
