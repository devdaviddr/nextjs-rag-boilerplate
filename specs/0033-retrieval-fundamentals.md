---
id: 0033
title: The retrieval fundamentals that were skipped
status: Proposed
release: '—'
created: 2026-09-10
updated: 2026-09-11
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

> **Measured, and the calibration did not clear the bar it was given
> (2026-09-11).** The cheap option was taken first, as this section recommends,
> and calibration against the endpoint's own `usage` counts — 15 samples of
> prose, table markup and OCR-like text, one `/embeddings` call each against
> `nvidia/nemotron-3-embed-1b` — is now in `src/lib/rag/chunk.ts`. It is a
> substantial improvement, and it is **not** what FR1 asks for.
>
> **The defect this section suspected was real, and worse than stated.** Against
> the provider's reported counts:
>
> |                  | `length / 4`            | the calibration |
> | ---------------- | ----------------------- | --------------- |
> | prose            | mean −9.6%, max 19%     | max 9.5%        |
> | OCR text         | mean −7.5%, max 17%     | max 7.3%        |
> | **table markup** | **mean −48%, max −60%** | **max 8.1%**    |
>
> Table markup runs at ~2 characters per token, not ~4, because a digit costs a
> token each. So a chunk the system believed was 512 tokens was really about a
> thousand, and every budget, overlap tail and boundary computed over it was out
> by a factor of two. That is not a rounding error in a knob; it is the chunker
> silently doing something other than what it was configured to do, on exactly
> the content [`0031`](0031-tables-figures-and-complex-layouts.md) had just
> added to the corpus.
>
> **The condition attached above was met, and its consequence has not been
> honoured.** This section says: if calibration cannot get within a few percent
> on table and OCR text, ship the real tokenizer. It gets to ~10% worst case
> (11% leaving each sample out of its own fit) — about four times the stated
> bar. `estimateTokens` is still an estimate and its own comment says so: _"It
> is not the model's vocabulary."_ So **1d is improved, not satisfied**, FR1 is
> still open, and this spec's answer is still a real tokenizer at ingestion
> time. What was bought is a six-fold improvement for no new dependency, which
> is worth having and is not the requirement.
>
> Two things about it that should not be lost:
>
> - **The hard slice was fixed too, and had the same bug.** `sliceToBudget` sized
>   its first guess at `budgetTokens * 4` characters — the same fixed ratio, on
>   the one path that exists precisely for the oversized table and OCR runs where
>   the ratio is worst. It now takes the first guess from the text's own measured
>   density and walks down until it fits.
> - **The calibration is not reproducible from the repo.** Whatever produced the
>   15 samples was never committed; five of them survive as a fixture in
>   `tests/unit/rag-chunk.test.ts`, recorded rather than fetched because a unit
>   test that needs an API key and a rate-limited shared account is not a unit
>   test. Refitting these constants means rebuilding that harness first.

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

### 1g — HyDE is built, and the evidence so far argues against it

Implemented behind `RAG_HYDE_ENABLED` (default off), 2026-09-11. It works
mechanically — 8/8 hypotheticals parsed via a native tool call, in a document's
voice with headings, defined terms and concrete numbers. The control call
without `tools` returned `"Here's a thinking process:"` and no passage,
reproducing what `rewrite.ts` and `planner.ts` already document about reasoning
models.

**Two measurements point the wrong way, and both are cases this spec expected
HyDE to win.**

1. **It invents the wrong document.** Asked to summarise an HR handbook, it
   wrote a fluent excerpt about a _RAG developer manual_ — FAISS index
   parameters and all — inferred purely from the file's title. That vector
   points away from the real document. Summarisation is precisely the case
   [`0027`](0027-agentic-rag-and-document-cracking.md) predicted HyDE would
   rescue.

2. **It manufactures plausible answers to unanswerable questions.** Given the
   corpus's canonical refusal case — "How much parental leave am I entitled
   to?", which the corpus cannot answer — it produced a detailed, plausible
   parental-leave policy. That embeds far closer to the corpus's real leave
   passages than the bare question does, pushing similarity **up** for a
   question that must refuse. NFR2's hazard in concrete form.

**Latency:** median 9.5s on the chat model (4.7–15.8s), 18.3s on the smaller
planner model (12.1–45.5s, worst case landing on the summarise question). The
call runs before the embedding, the search and the answer, so HyDE roughly
doubles time to first token.

**The head-to-head cannot run yet.** Three configurations are needed —
`scope.ts` alone, HyDE alone, both — and "HyDE alone" is not selectable, because
`resolveScope` is called unconditionally at `src/app/api/chat/route.ts` and in
three places in `eval/run.ts`. A `RAG_SCOPE_ENABLED` flag that nothing reads was
deliberately NOT added; shipping config that silently does nothing is the same
defect as [`0036`](0036-reranking.md)'s inert `RAG_RERANK_CANDIDATES`.

## Acceptance criteria

- [x] Token counts are within a stated tolerance of the provider's own
      `usage` figures, on prose, table markup and OCR text —
      `tests/unit/rag-chunk.test.ts`, _"is within 15% of the provider's own
      count on $kind"_, over five recorded `usage` counts covering prose, LaTeX
      `tabular`, a formulae table, a pipe table and OCR-like text. **The stated
      tolerance is 15%, not the "few percent" the Design section set as the bar
      for keeping the calibration** — this criterion asks only that a tolerance
      be stated and met, and that is a weaker thing than FR1 asks for. See the
      note under _1d — a real tokenizer_
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
- [x] Chunks still never span a page boundary — `tests/unit/rag-chunk.test.ts`,
      _"never lets a chunk span a page boundary"_ and _"still never lets a chunk
      span a page boundary when boxed"_, the second added with
      [`0035`](0035-span-level-citations.md)'s box-tracking so the invariant is
      re-proved on the path that walks items alongside the text (NFR3)
- [x] `docs/rag.md`'s chunking section reflects what is actually done — it
      described `length / 4`, which the calibration replaced, so it was not
      stale but false; rewritten with the measured error rates

> **Not verified (2026-09-11).** Every remaining criterion needs a measurement
> run, and none has been done:
>
> - **The four `pnpm rag:eval` checkpoints and the refusal-accuracy line.** 1d
>   is in the tree and **has not been measured**, which is the one thing the
>   Design section's ordering argument said must not happen. Table chunks got
>   roughly twice as small, `RAG_MIN_SIMILARITY` (0.35) was calibrated against
>   the old sizes, and _What a reviewer must not get wrong_ is specifically
>   about this: refusal has already fallen from 1.000 to 0.667 once in this
>   project while every other metric improved. The change's own commit message
>   says "Refusal must be re-measured before this ships." It has not been.
> - **1e's filtered-ANN recall** needs a database and a constructed small-share
>   tenant corpus as well as a run. `hnsw.iterative_scan` appears nowhere in the
>   tree; the only related artefact is `CANDIDATE_POOL_CEILING` in
>   `retrieve.ts`, which widens the candidate pool for the multi-KB case and is
>   neither this measurement nor a substitute for it.
> - **1c and 1g are unstarted.** No parent–child chunking exists — `Chunk` has
>   no parent link and no migration adds one — and there is no HyDE
>   implementation, so nothing has been measured against `scope.ts`. Their
>   criteria are open because the work is open, not because a run is pending.

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

  > **Done, and not by tuning the threshold (2026-09-11).** This entry assumed
  > the fix was `minVectorOps`. It was not: the threshold is **still 6**, and
  > the defect was that `vectorOpCount` counted the page template as content.
  > `signals.ts` now discounts full-width rules and page-size frames before
  > triage ever sees the number, so the running header, footer and border that
  > nearly every corporate PDF carries no longer clear the threshold on their
  > own. `itemCount` was fixed alongside it to exclude pdf.js's synthetic
  > whitespace spacers, with `denseItemRatio` recalibrated 8 → 10 to match.
  >
  > Measured on a realistically styled 8-page report: **8 of 8 pages routed to
  > the parser, now 6 of 8** — the two prose pages are free, and the chart,
  > the flowchart, both table pages and the scanned page still route.
  > `eval/corpus` is unchanged at 6 of 17, with the same route on every page,
  > which is the control that shows this narrowed the trigger rather than
  > weakening it.
  >
  > Two honest limits. The 8-page document **is not in the repo**, so that
  > figure is not reproducible from a checkout — `eval/make-corpus.mjs`
  > generates no page template, which is exactly why the regression was
  > invisible for so long. And the unit tests pin the mechanism (furniture
  > scores 0, a chart scores 3) rather than the outcome, so nothing would fail
  > if 6 of 8 regressed.

## References

- [`0027`](0027-agentic-rag-and-document-cracking.md) — the source of 1c, 1d,
  1e, 1g and the recommended sequencing this spec resumes.
- [`0032`](0032-settle-the-agentic-trade.md) — must record its baseline first.
- `src/lib/rag/chunk.ts` — `estimateTokens`, and its comment conceding the
  approximation.
- `src/db/schema.ts` — `chunks_owner_kb_idx` and the note on filtered ANN.
