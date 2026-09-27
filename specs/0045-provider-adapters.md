---
id: 0045
title: Talk to model providers through adapters, Anthropic included
status: Shipped
release: v0.27.0
created: 2026-09-27
updated: 2026-09-27
---

# 0045 — Talk to model providers through adapters, Anthropic included

## Summary

Every model call goes through a provider adapter chosen by the connection's
preset, instead of a raw `fetch` to an OpenAI-compatible `/chat/completions`.
The OpenAI-compatible adapter is today's behaviour; a native Anthropic adapter
is the second. Embeddings get provider-aware requests, so NVIDIA's
`input_type` goes only where it is understood.

## Problem / motivation

`src/lib/rag/client.ts` builds OpenAI-compatible requests by hand: `post()`
to `/chat/completions` and `/embeddings`, OpenAI's tool format, OpenAI's SSE
frames. Any provider without an OpenAI-compatible endpoint cannot be used,
and Anthropic's Claude models, a common choice for the planner and the writer,
need a proxy today. Role routing (`connectionFor`, `modelFor`, spec 0040) is
already the right seam; there is nothing behind it but one wire format.

Two smaller defects share the cause:

- Every embeddings request sends `input_type` (`client.ts`, `createEmbeddings`),
  which NVIDIA needs and other providers may reject as an unknown parameter.
- The OpenAI preset still notes that its embeddings are unusable because they
  are not 2048-dimensional (#64). Embedding generations of any size up to 4000
  shipped in v0.25.0, so the note is wrong.

## Goals

- A provider is one adapter module; the RAG code (planner, writer, verifier,
  reranker, figure reader, embeddings) never sees a wire format.
- Claude models can be the chat, planner and vision models, from Settings.
- Nothing changes for an existing OpenAI-compatible deployment.

## Non-goals

- **Anthropic embeddings.** Anthropic has no embeddings API; the embed role
  stays on an OpenAI-compatible connection.
- **Other native providers** (Gemini, Bedrock). One adapter proves the seam;
  more follow the same interface.
- **A per-generation similarity floor.** A different embedding model scores
  differently, so the floor should follow the generation, but choosing values
  needs measurement, deferred to #157. `docs/extending.md` says to re-check
  refusal after a switch.

## Requirements

### Functional

- **FR1** — A `ChatAdapter` interface: `complete(messages, options)` returns a
  normalised choice (content, tool calls, finish reason) and token usage;
  `stream(messages, signal)` returns the answer as OpenAI-style SSE frames, so
  `parseStreamFrame` and the answer path are unchanged. Amended while
  building: the adapter (`ProviderAdapter`) translates rather than calls —
  `chatRequest`, `chatResponse`, `chatStream`, `authHeaders` — with OpenAI's
  format as the common one. The transport stays the client's one `post()`, so
  retries and deadlines are shared by construction (NFR2), and the
  OpenAI-compatible adapter is the identity (NFR1).
- **FR2** — The OpenAI-compatible adapter is today's code moved behind that
  interface, request for request.
- **FR3** — An Anthropic adapter for the `anthropic` preset: Messages API
  (`/v1/messages`), `x-api-key` and `anthropic-version` headers, the system
  prompt as `system`, tools in Anthropic's format and `tool_use` blocks read
  back as tool calls, image parts for the vision role, and streamed
  `content_block_delta` events translated to SSE frames.
- **FR4** — The adapter is chosen from the connection's preset (`presetFor`).
  An `anthropic` connection may serve the chat, planner, vision and parse roles;
  Settings refuses it for the embed role with a plain message.
- **FR5** — Embeddings requests send `input_type` only for presets that accept
  it (NVIDIA NIM); others get the plain OpenAI request. Amended while
  building: "others" means providers known to reject unknown fields (OpenAI,
  OpenRouter). Custom and local servers keep it, since a self-hosted NIM behind
  the Custom preset needs it and llama.cpp, Ollama and vLLM ignore it.
- **FR6** — The OpenAI preset's stale note is removed: its embeddings work at
  their own size, like any generation.

### Non-functional

- **NFR1** — With no Anthropic connection, every request is byte-for-byte what
  it is today (existing client tests pass unmodified).
- **NFR2** — Retries, timeouts, the NIM 404 handling and error messages keep
  their current behaviour on both adapters.
- **NFR3** — API keys stay encrypted at rest and server-only (spec 0040).

## Design / approach

- `src/lib/rag/providers/types.ts`: `ChatAdapter`, the normalised choice
  (`RawChoice` from `planner.ts` is already the shape the callers read).
- `src/lib/rag/providers/openai.ts`: the current request building and SSE
  handling, moved.
- `src/lib/rag/providers/anthropic.ts`: request translation (messages, system,
  tools, images), response translation (`content[]` → content and tool calls,
  `usage.input_tokens`/`output_tokens`), stream translation.
- `client.ts` keeps its exported functions and signatures; each resolves the
  role's connection, picks the adapter, and delegates.
- `presets.ts`: an `anthropic` preset (`https://api.anthropic.com`, roles it
  can serve), and a flag for whether a preset's embeddings take `input_type`.

## Acceptance criteria

- [x] FR1, FR2: the OpenAI-compatible adapter passes the existing client tests
      unmodified (`rag-client-*.test.ts`) — unchanged and passing; the adapter
      is the identity (`providers/openai.ts`)
- [x] FR3: request and stream translation unit-tested against recorded
      Anthropic payloads, tool calls included — `rag-providers.test.ts`
      (system, merged turns, images, tools; `tool_use` back as tool calls;
      the event stream as frames `parseStreamFrame` reads; error events)
- [x] FR4: an Anthropic connection serves chat and planner; Settings refuses it
      for embeddings — `rag-providers.test.ts` _"the client with an Anthropic
      endpoint"_ (planner to `/messages` with its headers, chat streamed,
      embeddings refused); embeddings cannot be moved to a saved connection,
      and Settings' job test says Anthropic has no embeddings API. Not yet run
      against the live API (no key in this environment)
- [x] FR5: `input_type` is sent to NIM and not to other presets —
      `rag-providers.test.ts` _"input_type on embeddings"_
- [x] FR6: the OpenAI preset's note is gone — `presets.ts`
- [x] NFR1: an OpenAI-compatible deployment's requests are unchanged — the
      client tests, and the chat, RAG and Settings e2e suites against NIM

## Security & privacy

No change to where keys live or who can change them (admins, spec 0040). The
Anthropic adapter sends the same data the OpenAI-compatible one does, to a
different provider the admin chose.

## Alternatives considered

- **An AI SDK (Vercel AI SDK, LangChain) instead of hand-written adapters.**
  Fewer lines, but a large dependency whose abstractions would sit under the
  measured behaviours here (retries, NIM quirks, reasoning split, tool-call
  fallbacks) and move with its releases. Two small adapters keep that in view.
- **An OpenAI-compatible proxy in front of Anthropic.** Works today, but is one
  more service to run for the most common non-OpenAI provider.

## Out of scope / future

- Per-generation similarity floors (#157).
- Gemini, Bedrock and other native providers.

## References

- Spec 0040 (AI provider settings), #51 (capability), #144 (this spec), #64.
