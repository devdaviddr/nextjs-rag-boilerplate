# RAG — knowledge base & document chat

[← Back to README](../README.md) · Spec: [`0025`](../specs/0025-rag-knowledge-base-and-chat.md)

Upload PDFs into a private, per-user knowledge base and ask questions grounded
in them, with a page-level citation for every source used.

## How it works

```
upload → extract → chunk → embed → pgvector          (ingestion, out-of-band)
question → embed → kNN search → grounded answer      (retrieval)
```

| Stage    | Where                            | Notes                                                                                          |
| -------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Upload   | `src/lib/rag/actions.ts`         | Reuses spec 0007's MinIO storage, per-user quota and rate limit; narrowed to `application/pdf` |
| Extract  | `src/lib/rag/extract.ts`         | `unpdf`, in-process. Image-only PDFs are **rejected**, not partially ingested                  |
| Chunk    | `src/lib/rag/chunk.ts`           | Token-aware, paragraph-preferring, never spans a page boundary                                 |
| Embed    | `src/lib/rag/embed.ts`           | Batched + pooled, with backoff on 429                                                          |
| Store    | `chunks.embedding halfvec(2048)` | HNSW index, cosine                                                                             |
| Retrieve | `src/lib/rag/retrieve.ts`        | Owner-scoped kNN in SQL                                                                        |
| Answer   | `src/app/api/chat/route.ts`      | Streams NDJSON: citations, then tokens                                                         |

## Setup

A free NVIDIA NIM key from [build.nvidia.com](https://build.nvidia.com) —
rate-limited, not token-billed.

```bash
NVIDIA_API_KEY=nvapi-...
```

Without it the app still boots; `/documents` and `/chat` report themselves as
unconfigured. The `db` service must be `pgvector/pgvector:pg17` (already set in
both compose files) — the stock `postgres` image has no `vector` extension.

**Fully offline:** any OpenAI-compatible endpoint works.

```bash
RAG_LLM_BASE_URL=http://host.docker.internal:11434/v1
RAG_CHAT_MODEL=gpt-oss
```

Note the embedding model still has to produce 2048-dimension vectors to match
the column, or you need a migration.

## Three decisions worth knowing

**`halfvec(2048)`, not `vector(2048)`.** `nemotron-3-embed-1b` is the only
embedding model reachable on a free NIM account and it emits exactly 2048
dimensions — it rejects `dimensions: 1024`. pgvector can only build an HNSW or
IVFFlat index on a `vector` up to 2000 dimensions, so `vector(2048)` would
store fine and then _silently sequential-scan every query_. `halfvec` indexes
up to 4000.

**The embeddings are asymmetric.** The same sentence embedded as a passage and
as a query is only ~0.785 cosine-similar. `embed.ts` therefore exports
`embedPassages()` and `embedQuery()` and deliberately **no** generic `embed()`,
so a call site cannot quietly pick the wrong one.

**Refusal is a code path, not a prompt instruction.** If nothing clears
`RAG_MIN_SIMILARITY`, the chat model is never called and a fixed response is
returned. An empty knowledge base cannot produce a confident hallucination, and
costs nothing.

## Tuning

| Variable                                    | Default | Effect                                                          |
| ------------------------------------------- | ------- | --------------------------------------------------------------- |
| `RAG_CHUNK_TOKENS`                          | 512     | Bigger = more context per hit, less precise retrieval           |
| `RAG_CHUNK_OVERLAP_TOKENS`                  | 64      | Guards facts split across a chunk boundary                      |
| `RAG_TOP_K`                                 | 8       | Chunks fed to the model                                         |
| `RAG_MIN_SIMILARITY`                        | 0.35    | Below this, the question is answered as "not in your documents" |
| `RAG_EMBED_BATCH` / `RAG_EMBED_CONCURRENCY` | 32 / 4  | Ingestion throughput vs rate limits                             |
| `RAG_MAX_DOCUMENT_PAGES`                    | 200     | Bounds worst-case ingestion cost                                |

Measured against a 3-page synthetic handbook: on-topic questions scored
0.41–0.62 and an off-topic question scored 0.13. The 0.35 default sits in that
gap but nearer the true positives than is comfortable — raise it only with your
own corpus in front of you.

## Security

- **Tenant isolation is in the `WHERE` clause** (`chunks.owner_id`), not a
  post-filter and not the prompt. `tests/unit/rag-retrieve.test.ts` asserts it.
- **Indirect prompt injection**: uploaded PDFs are untrusted input that reaches
  the model. Retrieved text is fenced and labelled as data. This mitigates,
  it does not eliminate.
- **Document content leaves the machine** — chunks and questions go to the
  configured endpoint. Use a local endpoint if that is unacceptable.

## Known gaps

- No OCR, so scanned PDFs are rejected rather than half-ingested.
- No reranking — no reranker is reachable on a free NIM account.
- No evaluation harness yet; deliberately scoped to its own spec.
