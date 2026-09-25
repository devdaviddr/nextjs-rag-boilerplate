---
id: 0042
title: See what the RAG pipeline and its agents are doing
status: Proposed
release: '—'
created: 2026-09-26
updated: 2026-09-26
---

# 0042 — See what the RAG pipeline and its agents are doing

Tracked in [#75](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/75):
[#76](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/76) (Configuration
help),
[#77](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/77) (logs),
[#78](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/78) (runs),
[#79](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/79) (telemetry).

## Summary

Give admins an **Observability** area in the app: the system's logs, colour-coded
and live; a record of every question the app answered, step by step, showing
what the agents decided; and a dashboard of how retrieval and answering are
doing over time. Everything is stored in the app's own Postgres. Alongside it,
the AI settings move into one **Configuration** tab, and every setting gets a
plain-language explanation.

## Problem / motivation

- **Logs vanish.** `src/lib/logger.ts` writes JSON lines to stdout and nothing
  keeps them. On a self-hosted box they are only visible through
  `docker logs`, and they are gone after a restart.
- **The agents are a black box.** The only record of an agentic answer is one
  "Agentic trace" log line written after the fact. What the planner chose,
  what each search returned, whether HyDE or the reranker ran, and which
  citations verification removed are not recorded anywhere a person can read.
- **The numbers are never put together.** Each answer stores model, tokens,
  time to first token and total time (`messages.metrics`), but nothing shows
  them over time. Nobody can say whether refusals went up after a settings
  change, or how often the planner falls back.
- **Settings are unexplained.** Settings → Models names jobs like "HyDE" and
  "Page parser" with one line of help each.

## Goals

- An admin can find out why a given answer came out the way it did.
- An admin can see the system's health at a glance and spot a change.
- An admin can understand every AI setting without reading the docs.

## Non-goals

- An external observability stack (OpenTelemetry collector, Langfuse, Phoenix).
  The data model follows OpenTelemetry's shape so it can be exported later.
- Alerting and notifications.
- Per-user analytics or anything shown to non-admins.
- Replacing stdout logging: stdout stays, the database is an extra sink.

## Requirements

### Functional

- **FR1 — Configuration tab.** Settings → AI provider and Models become one
  **Configuration** tab with Providers and Models parts (Retrieval & answering
  joins with #57). Save buttons are always the primary style; saving with
  nothing changed says so.
- **FR2 — Setting help.** Every setting and job has an ⓘ that explains, in
  plain words, what it does, when it matters and what to watch for. It opens
  on hover with a mouse, on click or tap, and with Enter from the keyboard.
- **FR3 — Log store.** Every log line is also written to Postgres
  (`app_logs`): time, level, category, message, request id, user id and the
  rest as JSON. Writes are batched off the request path. Lines older than
  `LOG_RETENTION_DAYS` (default 7) are deleted. `LOG_PERSIST=false` turns the
  store off.
- **FR4 — Request context.** Every line written while handling a chat request
  or an ingestion carries its request id without the call site passing it.
- **FR5 — Categories.** Each line has a category: `agent`, `retrieval`,
  `inference`, `ingestion`, `auth`, `settings` or `system`.
- **FR6 — Agent events.** The pipeline logs what it decides, as it happens:
  the planner's chosen tool and query, each search's result count and best
  score, reranking, HyDE, citation verification (what was stripped), the
  termination reason and fallbacks.
- **FR7 — Logs page.** `/observability/logs`: newest first, live (new lines
  appear every couple of seconds; pausing stops it, scrolling down pauses it);
  filters by level, category and text; level shown as a coloured badge and
  category as a coloured stripe; a line expands to show its JSON; one click
  shows every line from the same request.
- **FR8 — Runs.** Every question produces a **run** (`rag_runs`) with its
  **steps** (`rag_spans`): rewrite, HyDE, search, rerank, planner, draft,
  verify, each with start, duration, model, tokens, status and details
  (queries, result counts, scores). Ingestion produces a run too, with
  extract, parse, embed and store steps. Full question and passage text are
  kept (decision 2).
- **FR9 — Run view.** `/observability/runs/[id]`: a waterfall of the steps,
  with a scrubber to replay the run step by step; each step expands to its
  details; links to its log lines and its conversation.
- **FR10 — Telemetry dashboard.** `/observability`: for the last 24 hours
  or 7 days, number tiles with a trend line (questions, refusal rate,
  median and p95 latency, median time to first token, tokens per answer,
  error rate); charts over time; how agentic runs ended; the distribution of
  best similarity against the floor; failures by model; ingestion outcomes;
  a list of recent runs.
- **FR11 — Access.** Admins only: the pages, their data routes and the
  sidebar item. Non-admins get a 404 for the pages and 403 for the data.

### Non-functional

- **NFR1** — Logging and telemetry never fail or noticeably slow a request:
  writes are buffered and flushed in the background; a database error drops
  the batch and says so on stdout. The buffer is bounded (drops oldest past
  5,000 lines, counting the drops).
- **NFR2** — No secrets in the store: keys whose name looks like a secret
  (`key`, `secret`, `password`, `token`, `authorization`, `cookie`) and values
  that look like API keys (`nvapi-…`, `sk-…`) are replaced with
  `[redacted]` before writing.
- **NFR3** — The edge runtime is untouched: the database sink is registered
  from `instrumentation.ts` in the Node runtime only; `logger.ts` stays
  dependency-free.
- **NFR4** — The dashboard queries stay fast on 30 days of data (indexed by
  time; aggregates computed in SQL).
- **NFR5** — Accessible: colours are never the only signal (level and
  category are also written as text), and axe finds no violations.

## Design / approach

**Storage.** One migration, three tables:

- `app_logs` — `id bigserial`, `time`, `level`, `category`, `message`,
  `request_id`, `user_id`, `meta jsonb`. Indexes on `time desc`, `request_id`,
  `(level, time)`.
- `rag_runs` — `id` (the request id), `kind` (`question` | `ingest`),
  `user_id`, `conversation_id`, `document_id`, `question`, `mode`
  (`search` | `document` | `agentic`), `status` (`ok` | `refused` | `error`),
  `termination`, `started_at`, `duration_ms`, `ttft_ms`, token counts,
  `best_similarity`, `source_count`, `models jsonb`, `error`. Indexes on
  `started_at desc`, `(kind, started_at)`.
- `rag_spans` — `id`, `run_id` (cascade), `parent_id`, `name`, `started_at`,
  `duration_ms`, `status`, `model`, `tokens`, `attributes jsonb`. Index on
  `run_id`.

Runs and spans are kept for `TELEMETRY_RETENTION_DAYS` (default 30).

**Logger.** `logger.ts` gains a pluggable sink (`setLogSink`) and a
per-category helper (`logger.for('agent')`). `src/lib/observability/` holds
the request context (`AsyncLocalStorage`: request id, user id, conversation
id), the redaction, the batched Postgres sink and the pruning, registered
from `instrumentation.ts`.

**Runs.** `startRun()` / `span(name, fn)` in `src/lib/observability/runs.ts`
time a step, record its outcome even when it throws, and nest by context.
The chat route and ingestion open a run; the pipeline's existing functions
are wrapped at their call sites, so their unit tests do not change.

**Pages.** `src/app/(dashboard)/observability/` with tabs Overview · Runs ·
Logs, and a sidebar item for admins. Charts use shadcn's chart primitives
over Recharts, loaded only on the Overview. The log list keeps at most 2,000
lines in the browser, with older pages loaded on request, which made
virtualisation unnecessary. The run waterfall, the log console, the
partition bar and the stat tiles follow the designs of 21st.dev's _Agent
Trace_ (NIMA MZ), _Log Viewer_ (hirael), _Partition Bar_ (8starlabs) and
_Stats Grid_ (shadcnui-blocks), all MIT, built here from their published
descriptions.

## Acceptance criteria

- [x] FR1–FR2: one Configuration tab; every setting has help that opens by
      hover, click or tap, and the keyboard — e2e `settings-ai.spec.ts`
      _"every AI setting explains itself"_; axe clean with the model list open
- [x] FR3–FR5: a chat request's log lines are in `app_logs` with its request
      id and a category; retention deletes old lines — checked live
      2026-09-26 (one question: 7 lines, one request id, categories agent /
      retrieval / inference); `tests/unit/observability-logs.test.ts`
- [x] FR6: an agentic answer logs the planner's decisions and each search —
      "Planner chose to search", "Search found 5 passages", "Planner chose to
      answer" in the same live check
- [x] FR7: the Logs page shows new lines live, filters, expands and groups
      by request — e2e `observability.spec.ts` _"an admin reads the logs"_
- [ ] FR8–FR9: a question produces a run with its steps; the run view shows
      the waterfall and replays it
- [ ] FR10: the dashboard shows the tiles and charts for 24 hours and 7 days
- [ ] FR11: non-admins get 404 / 403 everywhere
- [x] NFR1: a failing database does not fail a request (tested) —
      _"drops a batch the database refuses"_, _"never lets a failing sink
      break the caller"_, and the bounded queue
- [x] NFR2: secrets are redacted before storage (tested) — _"redact
      (NFR2)"_
- [ ] NFR5: axe finds no violations on the three pages

## Security & privacy

- The store holds users' questions and passages from their documents
  (decision 2). It is admin-only, and retention bounds it.
- Secrets are redacted before storage (NFR2); API keys never reach the
  logger in the first place (spec 0040 NFR3).
- The data routes check the admin role themselves, as the settings actions do.

## Alternatives considered

- **Langfuse / Phoenix / an OpenTelemetry collector.** Richer, but each is
  another service to run and secure on a self-hosted box. The span model here
  is compatible, so exporting later stays possible.
- **In-memory ring buffer for logs.** No storage cost, but lost on restart
  and per-instance, which is exactly today's problem.
- **Streaming logs with SSE.** Polling every two seconds with an id cursor is
  simpler, survives proxies, and is plenty for a human reading.

## Decisions (2026-09-26)

1. Logs are stored in Postgres, kept 7 days by default.
2. Telemetry is built in, and runs keep the full question and passage text.
3. The pages live under an **Observability** sidebar item, admins only.
4. Custom components follow 21st.dev designs, built here rather than
   installed, so no 21st.dev account is needed.

## References

- `src/lib/logger.ts`, `src/app/api/chat/route.ts` (the agentic trace line)
- `src/db/schema.ts` → `StoredMetrics`
- Spec 0029 (agentic retrieval), 0040 (AI settings)
