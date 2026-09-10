---
id: 0033
title: The retrieval fundamentals that were skipped
status: Proposed
release: '—'
created: 2026-09-10
updated: 2026-09-10
---

# 0033 — The retrieval fundamentals that were skipped

## Summary

[`0027`](0027-agentic-rag-and-document-cracking.md) recommended a sequence:
evaluation harness, then contextual headers and hybrid retrieval, then
**chunking and tokenizer**, then index tuning — and only then the agentic loop.
Steps 1, 2 and the loop shipped. Step 3 did not. Its tracker still reads
`1c Not started`, `1d Not started`, `1e Not started`, `1g Not started`.

This spec closes those four. They are grouped rather than taken separately
because 0027 says explicitly that their effects **interact and must be measured
against each other**, and because three of them touch the same two files.

## Problem / motivation

Retrieval quality currently rests on chunking and `top_k` alone — there is no
reranker on this NIM account (re-probed 2026-09-10 across 80 models), so the
usual second-stage fix is unavailable. That makes the first stage matter more
here than in a typical deployment, and the first stage was never finished.

**1d — the token counter is a guess.** `estimateTokens` in
`src/lib/rag/chunk.ts` is `Math.ceil(text.length / 4)`, and its own comment
admits it: _"Named 'estimate' because it IS one."_ Every chunk boundary, every
overlap tail and every budget in the system is sized by that guess. The comment
rejects a real tokenizer as "a multi-megabyte dependency to size a chunk" —
which was a reasonable call before chunks carried tables and OCR text, whose
character-to-token ratios are nothing like prose.

**1c — chunking is flat.** A chunk is a token-budget slice of a page. Nothing
relates a chunk to the section it came from beyond a prefixed heading string, so
a question answered by a section's _shape_ rather than one passage has nothing
to retrieve. Document cracking now emits **typed elements** — `Section-header`,
`Table`, `Picture`, `Text` — which makes parent–child chunking far more
tractable than when 0027 proposed it against flat text.

**1e — the index is untuned.** `chunks_owner_kb_idx` leads with `owner_id`, and
the HNSW index applies its filter _after_ the ANN scan. 0027 flagged the failure
mode: a tenant holding a small share of all chunks can silently get degraded
recall as the corpus grows — correct results, quietly worse, no error.
`hnsw.iterative_scan = relaxed_order` (pgvector 0.8) is the lever and has never
been measured.

**1g — HyDE was never evaluated**, and 0027 notes it _competes_ with the
existing `scope.ts` regex rather than complementing it. Two mechanisms aimed at
the same problem, neither measured against the other.

## Goals

- Chunk sizing is based on a real token count, not a character ratio.
- A question whose answer spans a section retrieves that section, not a slice
  of it.
- Filtered ANN recall is measured, and tuned if measurement says it needs it.
- HyDE and `scope.ts` are measured **against each other**, and the loser is
  removed rather than left in place.

## Non-goals

- Reranking (1f) — [`0036`](0036-reranking.md) now covers it. It is the largest
  available precision gain and does not belong buried in a non-goal here.
- Changing the embedding model or the `halfvec(2048)` column.
- Anything about the agentic loop. This spec changes what the loop searches
  **over**, and must be measured after [`0032`](0032-settle-the-agentic-trade.md)
  records its baseline, never folded into it.

## Requirements

### Functional

- **FR1** — Chunk sizing uses a real tokenizer for the configured embedding
  model, replacing `estimateTokens`'s character ratio.
- **FR2** — The tokenizer's cost is bounded: it must not add a multi-megabyte
  dependency to the client bundle, and it must not run per request. Chunking is
  an ingestion-time concern.
- **FR3** — Chunking becomes structure-aware: a `Section-header` and the
  elements beneath it form a retrievable unit, with the passage-level chunks
  retained beneath it (parent–child).
- **FR4** — Retrieval can return a parent when several of its children match,
  rather than returning three adjacent slices of the same section.
- **FR5** — Filtered-ANN recall is measured for a tenant holding a small share
  of total chunks, and `hnsw.iterative_scan` is set on evidence.
- **FR6** — HyDE is implemented behind a flag and measured **against**
  `scope.ts` on the same questions. Whichever loses is removed or left off with
  the numbers recorded.

### Non-functional

- **NFR1** — Each of 1d, 1c, 1e and 1g is measured **separately** before any
  combined number is reported. 0027's whole argument for grouping them is that
  their effects interact; a single combined delta would hide which one paid.
- **NFR2** — Refusal accuracy holds at 1.000 throughout. Chunk boundaries move
  similarity scores, and the similarity floor is what refusal rests on.
- **NFR3** — Chunks still never span a page boundary. That is what makes every
  citation resolve to an exact page (spec 0025 FR6) and it is not negotiable
  for a recall gain.
- **NFR4** — Any change requiring a re-ingest says so, and existing documents
  keep working until re-ingested.

## Design / approach

### Order, and why

1. **1d tokenizer first.** It is the smallest change, it moves every chunk
   boundary in the corpus, and every subsequent measurement is against
   differently-sized chunks. Doing it after 1c would invalidate 1c's numbers.
2. **1e index tuning second.** Independent of chunk content; measurable on its
   own; and it wants doing before the corpus grows.
3. **1c structure-aware chunking third.** The largest change, and the one that
   benefits from a correct token count.
4. **1g HyDE last**, as a head-to-head against `scope.ts`.

### 1d — a real tokenizer

The embedding model is `nvidia/nemotron-3-embed-1b`. The honest options are a
tokenizer package pinned to that model's vocabulary, or a small local
approximation calibrated against the endpoint's own reported token counts —
which the client already receives in every `usage` frame.

The second is worth measuring first because it is nearly free: the corpus is
already embedded, the provider already reports true token counts, and a
calibration table beats `length / 4` without shipping a vocabulary. If
calibration cannot get within a few percent on table and OCR text, ship the real
tokenizer at ingestion only (FR2).

### 1c — parent–child chunking

Cracked pages already produce `NormalizedElement`s carrying `heading` and
`atomic`. A parent is the run of elements under one `Section-header`; children
are today's token-budget chunks. Both are embedded; retrieval prefers the parent
when several children of the same parent match.

The text-layer path has no elements, so it needs a heading-run equivalent from
`detectHeading` — weaker, and that asymmetry should be stated rather than
hidden. It also means the benefit accrues mostly to cracked documents.

### 1e — filtered ANN

Construct a corpus where one owner holds a small share of chunks, measure recall
against exact search, then set `hnsw.iterative_scan` and measure again. If
recall is already at parity, record that and change nothing — a tuning knob set
without evidence is worse than an untuned default, because the next person
believes it was measured.

### 1g — HyDE versus `scope.ts`

Both address "the question does not look like the passage that answers it".
Running both risks one masking the other's failures. Measure: `scope.ts` alone
(today), HyDE alone, both. Keep what wins; delete or disable what does not.

### What a reviewer must not get wrong

**Chunk boundaries move refusal.** The similarity floor (`RAG_MIN_SIMILARITY`,
0.35) is calibrated against chunks of the current size, and refusal accuracy —
the strongest guarantee in this system — is what sits on top of it. Every change
here resizes chunks, so refusal must be re-checked after each one and not just
at the end. This project has already seen refusal fall from 1.000 to 0.667
_while every other metric improved_.

## Acceptance criteria

- [ ] Token counts are within a stated tolerance of the provider's own
      `usage` figures, on prose, table markup and OCR text —
      `tests/unit/rag-chunk.test.ts`
- [ ] `pnpm rag:eval` after 1d alone, recorded, refusal 1.000
- [ ] Filtered-ANN recall measured for a small-share tenant, with the
      `hnsw.iterative_scan` decision and its numbers recorded here
- [ ] `pnpm rag:eval` after 1e alone, recorded
- [ ] A question answered by a whole section retrieves the parent rather than
      three adjacent children — `eval/questions.json`
- [ ] `pnpm rag:eval` after 1c alone, recorded
- [ ] HyDE measured alone, `scope.ts` measured alone, and both together, on the
      same questions — the loser removed or disabled with numbers stated
- [ ] Refusal accuracy is 1.000 at every one of those checkpoints
- [ ] Chunks still never span a page boundary — `tests/unit/rag-chunk.test.ts`
- [ ] `docs/rag.md`'s chunking section reflects what is actually done

## Security & privacy

No new data leaves the deployment. 1e touches the index that enforces tenant
filtering at the query planner level — the `owner_id` and `knowledge_base_id`
predicates in `retrieve.ts` remain the boundary, and index tuning must not be
allowed to become a reason to relax them.

## Alternatives considered

- **Do these before 0032.** Tempting, since they improve the thing 0032
  measures. Wrong order: 0032's whole purpose is a clean baseline of the current
  system, and moving the floor underneath it makes its comparison meaningless.
- **Take them one spec at a time.** More granular, and it loses the property
  0027 asked for — that their interaction is measured. NFR1 keeps the individual
  numbers without splitting the work.
- **Skip 1d, keep `length / 4`.** Defensible while chunks were prose. Tables and
  OCR text have very different ratios, and cracking put both in the corpus.
- **Skip 1c, rely on the agentic loop to search twice.** Substituting an
  expensive runtime loop for cheap ingestion-time structure — exactly the
  inversion 0027 warned against when it put chunking before the loop.

## Out of scope / future

- Reranking — [`0036`](0036-reranking.md).
- Fine-tuning an embedding model on the corpus (0027 rejected this as
  disproportionate; it still is).
- **Triage tuning.** `minVectorOps: 6` routes every page of a document with
  ruled headers and footers to the parser, which is a cost problem in
  [`0031`](0031-tables-figures-and-complex-layouts.md)'s territory rather than a
  retrieval-quality one. Tracked separately.

## References

- [`0027`](0027-agentic-rag-and-document-cracking.md) — the source of 1c, 1d,
  1e, 1g and the recommended sequencing this spec resumes.
- [`0032`](0032-settle-the-agentic-trade.md) — must record its baseline first.
- `src/lib/rag/chunk.ts` — `estimateTokens`, and its comment conceding the
  approximation.
- `src/db/schema.ts` — `chunks_owner_kb_idx` and the note on filtered ANN.
