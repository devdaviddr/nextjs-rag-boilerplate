---
id: 0025
title: PDF knowledge base & document chat (RAG)
status: Shipped
release: 'v0.20.0'
created: 2026-09-07
updated: 2026-09-08
---

# 0025 — PDF knowledge base & document chat (RAG)

## Summary

Turn the boilerplate into a retrieval-augmented generation app. A signed-in user
uploads PDFs into a private knowledge base; each PDF is text-extracted, chunked,
embedded, and stored as vectors in the existing Postgres via **pgvector**. The
user then asks questions in a chat UI and gets answers **grounded in their own
documents**, with a citation back to the source page for every claim.

Everything already in the boilerplate is reused rather than rebuilt: MinIO holds
the PDF blobs, the `files` pattern and per-user quota bound storage, Auth.js
scopes ownership, and rate limiting bounds cost. The only new infrastructure is
a Postgres **extension** — no fourth container.

## Problem / motivation

The boilerplate gets you auth, storage, and a database on day one, but every RAG
project then re-solves the same five problems from scratch: where vectors live,
how PDFs become text, how chunks are embedded without blowing a rate limit, how
retrieval is scoped so one tenant cannot read another's documents, and how the
model is stopped from answering confidently from parametric knowledge when the
answer is not in the corpus.

Those are the parts worth getting right once. This spec builds them on top of
0007 (file uploads) and 0006 (RBAC) rather than beside them.

## Goals

- A user can upload PDFs into a private knowledge base and see ingestion progress
  per document.
- A user can ask a natural-language question and receive a streamed answer
  grounded **only** in their own documents.
- Every answer carries citations resolving to a document and page number.
- When retrieval finds nothing relevant, the system says so instead of answering.
- No cross-tenant leakage: a retrieval query can only ever match the caller's own
  chunks.
- Ingestion of a 50-page born-digital PDF completes without manual intervention
  and without exceeding the free NIM tier's rate limits.

## Non-goals

- **OCR / scanned PDFs.** Image-only PDFs are detected and rejected with a clear
  message, not partially ingested. See Alternatives.
- **Reranking.** No cross-encoder reranker is available on this NIM account, so
  retrieval quality rests on chunking and `k`. Not faked with a second LLM pass.
- Non-PDF formats (docx, html, csv), multi-user shared knowledge bases,
  agentic multi-hop retrieval, conversation memory beyond the current thread,
  and fine-tuning.
- Evaluation harness — deliberately deferred to its own spec (see Out of scope).

## Requirements

### Functional

- **FR1** — `documents` table: `id`, `ownerId` → `users.id`, `fileId` →
  `files.id`, `title`, `pageCount`, `status`, `error`, `createdAt`, `updatedAt`.
  `status` is one of `pending | extracting | embedding | ready | failed`.
- **FR2** — `chunks` table: `id`, `documentId` → `documents.id` (cascade delete),
  `ownerId` (denormalised for query-time scoping), `content`, `pageNumber`,
  `chunkIndex`, `tokenCount`, `embedding halfvec(2048)`.
- **FR3** — `uploadDocument(formData)` Server Action: reuses 0007's validation
  and quota, restricted to `application/pdf`, stores the blob in MinIO, creates
  the `documents` row as `pending`, and schedules ingestion.
- **FR4** — Ingestion pipeline, run out-of-band from the request:
  extract → detect empty text layer → chunk → embed → persist → `ready`.
  Any failure sets `status = failed` with a human-readable `error`.
- **FR5** — Text extraction via `unpdf` in-process, producing per-page text. A
  document whose extractable text is below `RAG_MIN_CHARS_PER_PAGE` (default 50)
  averaged across pages is rejected as image-only with an actionable message.
- **FR6** — Chunking: `RAG_CHUNK_TOKENS` (default 512) with
  `RAG_CHUNK_OVERLAP_TOKENS` (default 64), split on paragraph boundaries where
  possible, never spanning a page boundary so citations stay page-exact.
- **FR7** — Embedding via `nvidia/nemotron-3-embed-1b` with
  **`input_type: "passage"`** for chunks, batched (`RAG_EMBED_BATCH`, default 32)
  with bounded concurrency (`RAG_EMBED_CONCURRENCY`, default 4) and exponential
  backoff on HTTP 429.
- **FR8** — `listMyDocuments()` and `deleteDocument(id)` Server Actions,
  ownership-checked. Deleting a document removes its chunks, its `files` row and
  its MinIO object.
- **FR9** — Retrieval: embed the question with **`input_type: "query"`**, then
  cosine-distance search over `chunks` filtered to `ownerId = session.user.id`,
  returning top `RAG_TOP_K` (default 8) above `RAG_MIN_SIMILARITY` (default 0.35).
- **FR9a** — Query scoping: a whole-document request (summarise / overview /
  "what is in X") retrieves the named document in reading order instead of by
  similarity, because such a request has no semantic anchor in the content and
  scores near zero. Ambiguous requests fall back to similarity search rather
  than guessing a document.
- **FR10** — `POST /api/chat`: streams a grounded answer from
  `nvidia/nemotron-3-super-120b-a12b`, given only the retrieved chunks as
  context. If retrieval returns nothing above threshold, it returns a fixed
  "not in your documents" response **without calling the chat model**.
- **FR11** — Every response carries a `citations` array of
  `{ chunkId, documentId, documentTitle, pageNumber }`; the UI renders them
  under the answer, each linking to the source document.
- **FR12** — Chat UI at `/chat`: threaded messages, streamed tokens, visible
  citations, and an empty state that tells the user to upload documents first.
- **FR13** — Knowledge-base UI at `/documents`: upload, list with per-document
  status and page count, retry a failed document, delete.

### Non-functional

- **NFR1** — **Tenant isolation is enforced in the query, not the prompt.** Every
  retrieval `WHERE` clause includes `ownerId`. A test asserts user B's question
  cannot retrieve user A's chunk.
- **NFR2** — The NIM API key is server-only (`server-only` guard, never
  `NEXT_PUBLIC_`), consistent with `src/db` and `src/lib/storage`.
- **NFR3** — Chat and upload endpoints are rate-limited per user via the
  existing `src/lib/rate-limit.ts`, since both spend a finite free-tier quota.
- **NFR4** — A `RAG_MAX_DOCUMENT_PAGES` ceiling (default 200) bounds worst-case
  ingestion cost, mirroring the existing upload size cap.
- **NFR5** — Ingestion is resumable: re-running a `failed` document must not
  duplicate chunks (delete-then-insert per document, in a transaction).
- **NFR6** — The chat route streams; time-to-first-token is not gated on the
  full generation.

## Design / approach

### The constraint that shapes the schema

Three measured facts, in order, force the vector column type:

1. **`nvidia/nemotron-3-embed-1b` is the only embedding model this account can
   reach.** `snowflake/arctic-embed-l`, `nvidia/llama-3.2-nv-embedqa-1b-v1` and
   `nvidia/nv-embedqa-mistral-7b-v2` all return `404 Not found for account`.
2. **Its output is fixed at 2048 dimensions.** Passing `dimensions: 1024`
   returns `dimensions must be one of 2048` — no Matryoshka truncation.
3. **pgvector cannot index a `vector` above 2000 dimensions.** HNSW and IVFFlat
   both cap there.

So `vector(2048)` would store fine and then silently fall back to a sequential
scan on every query. The column is therefore **`halfvec(2048)`**, which pgvector
indexes with HNSW up to 4000 dimensions at half precision. The recall cost of
fp16 is negligible next to losing the index entirely.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE chunks ADD COLUMN embedding halfvec(2048);

CREATE INDEX chunks_embedding_idx ON chunks
  USING hnsw (embedding halfvec_cosine_ops);

CREATE INDEX chunks_owner_idx ON chunks (owner_id);
```

The `db` service image changes from `postgres:17-alpine` to
**`pgvector/pgvector:pg17`** in `docker-compose.yml` and
`docker-compose.prod.yml`. The stock Postgres image does not ship the extension.
This is the one infrastructure change in the spec; the existing backup scripts
keep working unchanged because it is still a plain Postgres volume.

### The embeddings are asymmetric — this is not optional

Measured on the same sentence embedded both ways:

| Pair                                        | Cosine    |
| ------------------------------------------- | --------- |
| `passage(t)` vs `query(t)` — identical text | **0.785** |
| `passage(t)` vs `query(question about t)`   | 0.611     |

An identical string embedded as a passage and as a query is only 0.78 similar.
Embedding chunks and questions the same way therefore measurably degrades
retrieval. `src/lib/rag/embed.ts` exposes two functions —
`embedPassages()` and `embedQuery()` — and no general-purpose `embed()`, so the
distinction cannot be accidentally collapsed at a call site.

### Ingestion runs after the response

A 200-page PDF is hundreds of embedding calls against a rate-limited free tier;
that cannot happen inside a Server Action's request. Ingestion is scheduled with
Next.js 16's `after()` and drives the `documents.status` machine, which the
`/documents` page polls. No queue, no worker container — consistent with the
boilerplate's deliberate "no queue" stance in 0007.

`pending → extracting → embedding → ready`, or `→ failed` with an `error`.

### Grounding is a retrieval decision, not a prompt instruction

If no chunk clears `RAG_MIN_SIMILARITY`, the chat model is **never called** and a
fixed response is returned. Refusal is a code path, not a behaviour we hope the
model exhibits — which also means an empty knowledge base cannot produce a
confident hallucinated answer, and costs nothing.

The system prompt additionally instructs answering only from supplied context,
but that is the second line of defence, not the first.

### Module layout

```
src/lib/rag/
  client.ts      NIM client, server-only, shared by embed + chat
  embed.ts       embedPassages() / embedQuery() — batching, backoff
  extract.ts     unpdf per-page text + image-only detection
  chunk.ts       token-aware, page-bounded chunking
  retrieve.ts    owner-scoped kNN over halfvec
  ingest.ts      the status machine
src/app/(app)/documents/   knowledge base UI
src/app/(app)/chat/        chat UI
src/app/api/chat/route.ts  streaming grounded chat
```

## Acceptance criteria

- [x] `docker compose up` starts Postgres with the `vector` extension available.
- [x] Uploading a born-digital PDF moves it `pending → ready` unattended, and the
      `/documents` list reflects each transition.
- [x] Uploading an image-only PDF sets `failed` with a message naming OCR as the
      reason, and creates zero chunks.
- [x] `chunks.embedding` is `halfvec(2048)` with an HNSW index, verified by
      `EXPLAIN` showing an index scan rather than a sequential scan.
- [x] Asking a question answerable from an uploaded document returns a streamed
      answer citing the correct document and page.
- [x] Asking a question unrelated to any uploaded document returns the fixed
      "not in your documents" response, with no chat-model call in the logs.
- [x] An automated test proves user B cannot retrieve user A's chunks.
- [x] Deleting a document removes its chunks, its `files` row and its MinIO
      object, leaving no orphans.
- [x] Re-ingesting a `failed` document produces no duplicate chunks.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.

## Security & privacy

- **Cross-tenant leakage** is the primary threat. Mitigated at the query layer
  (NFR1) with a dedicated test, not by trusting a prompt or a filter applied
  after retrieval.
- **Indirect prompt injection from document content.** An uploaded PDF is
  untrusted input that reaches the model. Retrieved chunks are wrapped in a
  clearly delimited context block and the system prompt states that content
  inside it is data, never instructions. This mitigates but does not eliminate
  the risk; it is named here rather than assumed away.
- **Document content leaves the machine.** Chunks and questions are sent to
  NVIDIA NIM. This is the single external dependency and must be stated plainly
  in the UI before first upload. `RAG_LLM_BASE_URL` accepts any OpenAI-compatible
  endpoint, so pointing it at a local Ollama or llama.cpp gives a fully offline
  deployment — at a quality cost.
- **Key handling** — server-only (NFR2); never reaches the browser.
- **Cost / DoS** — per-user rate limits (NFR3), page ceiling (NFR4) and the
  inherited storage quota bound how much a single account can spend.

## Alternatives considered

- **Dedicated vector database (Qdrant / Chroma).** Better at very large scale and
  richer filtering, but adds a fourth service, a second backup path, and a second
  source of truth to keep consistent with Postgres. pgvector holds far past the
  scale a boilerplate demo reaches.
- **`vector(2048)` without an index.** Simpler type, but every query becomes a
  sequential scan over every chunk. Rejected — it fails silently rather than
  loudly, which is the worst failure mode.
- **A smaller embedding model to stay under 2000 dims.** Every alternative NIM
  embedding model returns 404 on this account, and `nemotron-3-embed-1b` refuses
  dimension truncation. Not available, not merely rejected.
- **Python sidecar with PyMuPDF + Tesseract for OCR.** Genuinely more capable and
  would handle scanned PDFs, but breaks the single-app-container simplicity that
  makes this boilerplate deployable with one command. Deferred, not dismissed.
- **Vercel AI SDK for streaming.** Ergonomic, but a substantial dependency for
  what a route handler returning a `ReadableStream` over the OpenAI-compatible
  SSE format already does. Revisit if the chat UI grows tool calling.
- **`nemotron-3.5-lightning-30b-a3b` as the default chat model.** Confirmed
  reachable and likely faster; `nemotron-3-super-120b-a12b` is the default for
  answer quality, and the model is a single env var to change.

## Out of scope / future

- **Evaluation harness** — a fixed question set with expected source pages,
  reporting retrieval recall and citation accuracy. Genuinely important and
  deliberately its own spec, so it is not skipped under feature pressure.
- OCR path for scanned PDFs (0007-style sidecar or `nemotron-parse`).
- Reranking, if a reranker becomes available on the account.
- Shared / team knowledge bases, building on 0006 RBAC.
- Hybrid retrieval — Postgres full-text search unioned with vector search.
- Conversation memory across threads.

## References

- Built on [`0007`](0007-file-uploads.md) (MinIO, quota, ownership) and
  [`0006`](0006-rbac.md) (roles, guards).
- Upstream: `devdaviddr/nextjs-fullstack-boilerplate` @ `736f6de`, retained as
  the `upstream` git remote.
- NIM model availability, embedding dimensions and the passage/query asymmetry
  above were measured against `https://integrate.api.nvidia.com/v1` on
  2026-09-07, not taken from model cards.
- pgvector index dimension limits: 2000 for `vector`, 4000 for `halfvec`.
