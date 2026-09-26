---
id: 0033
title: The retrieval fundamentals that were skipped
status: Proposed
release: '—'
created: 2026-09-10
updated: 2026-09-26
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
  the numbers recorded. _Resolved without the head-to-head: HyDE was removed
  (#27), for the reasons under 1g — decision._

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
  keep working until re-ingested. 1c requires none. What existing rows get
  depends on how they were ingested: cracked rows ingested since 0038 carry
  `heading_bbox` and group by section; cracked rows from before 0038 carry
  per-element headings but no box, so they group by heading text — section
  level, except that adjacent sections sharing a title on one page merge;
  text-layer rows from before 0039 have one `detectHeading` line per page and
  group at page level. Every case is still single-page and still gated;
  re-ingesting brings the first two cases to exact sections and gives the
  third sections when the PDF reports point sizes.

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

> **1d — measured on retrieval (2026-09-25).** An A/B on the same tree
> (main @ v0.21.1): `pnpm rag:eval` as shipped, then again with
> `estimateTokens` temporarily returning `length / 4`, re-ingesting the corpus
> each time, cracking off, fixed pipeline. Single-hop slice, n=20 (17
> answerable):
>
> |                  | `length / 4` | calibrated (1d) |
> | ---------------- | ------------ | --------------- |
> | hit@1            | 0.941        | 0.882           |
> | hit@3 / hit@8    | 0.941        | 0.941           |
> | MRR              | 0.941        | 0.912           |
> | refusal accuracy | 1.000        | **1.000**       |
> | cross-KB leakage | 0            | 0               |
>
> The whole difference is **one question**: `notice-period` moves from rank 1
> to rank 2 — employment-contract p1 (0.543) now outranks p2, which holds the
> answer. Every other per-question result is identical, chunk counts per
> document are identical, and the followup, multi-hop and layout slices do not
> move. It is not noise: the same 0.941 → 0.882 step appears between the
> hybrid-retrieval baseline in `docs/rag.md` and the first eval after 1d
> landed. **Refusal holds**, which was the risk this section and _What a
> reviewer must not get wrong_ flagged. The calibration stays: it is the
> difference between a 512-token budget meaning ~512 tokens and meaning ~1,000
> on table markup, and one rank-2 result on a 17-question slice does not
> outweigh that. FR1 — a real tokenizer — is still open, unchanged by this.

### 1c — parent–child chunking

Cracked pages already produce `NormalizedElement`s carrying `heading` and
`atomic`. A parent is the run of elements under one `Section-header`; children
are today's token-budget chunks. ~~Both are embedded~~ **Children are embedded;
the parent is assembled from gated children**; retrieval prefers the parent
when several children of the same parent match.

> **Amended (2026-09-25, #26) — the parent is assembled, not embedded.** A
> section-sized vector is a new similarity distribution, and the 0.35 floor
> (NFR2) was calibrated against chunk-sized ones; embedding parents would move
> what the floor means on exactly the metric this spec holds at 1.000. So a
> parent is the contiguous run of non-figure chunks on one page sharing a
> section key — `heading` plus `heading_bbox`, both already stored — and it is
> assembled after the gate, only when **two or more** of its chunks were
> admitted on their own cosine. Its score is the best admitted child's. FR3's
> "retrievable unit" is met because the parent is the unit retrieval returns;
> FR4 is met by construction. What it costs, stated: a section where no two
> children clear the floor on their own can never surface as a parent. No
> migration and no re-ingest (NFR4). Code: `src/lib/rag/parents.ts`, with
> `assembleParents` in `retrieve.ts`.
>
> **A second cost, in the agentic loop.** The attempt-scaled floor (0.35 +
> 0.04 per extra search) re-filters on `similarity`, and a parent's is its
> best member's, including a member absorbed from another search. So the
> floor scores a parent as it would its best child, and refusal cannot move:
> a list is empty exactly when its best score is under the floor. The text is
> another matter. A parent kept on its best child carries its whole run,
> members under the raised floor and members never admitted included. Before
> parents, only the passing child's text survived. The raised floor therefore
> bounds scores, not text; accepted, because a parent's text is the whole
> section at the base floor too, and pinned in `rag-agentic.test.ts`.

~~The text-layer path has no elements, so it needs a heading-run equivalent from
`detectHeading` — weaker, and that asymmetry should be stated rather than
hidden. It also means the benefit accrues mostly to cracked documents.~~

> **Corrected (2026-09-25).** Since
> [`0039`](0039-structure-from-the-text-layer.md) the text-layer path DOES
> produce elements: a PDF that reports point sizes gets headings from
> `layout.ts`. There are three paths, and the parent differs by path:
>
> - **cracked** — the parser's `Section-header` elements; the parent is the
>   section.
> - **text layer with point sizes** — lines set larger than the body; the
>   parent is the section.
> - **`chunkPages` fallback** — one `detectHeading` line per page and no heading
>   box, so the parent is the whole page, capped at `3 × RAG_CHUNK_TOKENS`.
>
> **Measured limitation.** A heading set at body size — the ALL-CAPS first line
> of every page in `eval/corpus`'s original documents — is not detected by
> `layout.ts`, so each of those pages is one chunk and 1c changes nothing there.
> That makes them the control for 1c's own measurement. The evaluation adds
> `records-policy`, generated with explicit point sizes, for the questions 1c
> is meant to change.

### 1e — filtered ANN

Construct a corpus where one owner holds a small share of chunks, measure recall
against exact search, then set `hnsw.iterative_scan` and measure again. If
recall is already at parity, record that and change nothing — a tuning knob set
without evidence is worse than an untuned default, because the next person
believes it was measured.

> **1e — measured (2026-09-25).** A scratch database with the same table
> shape: the 61 real chunk embeddings plus 30,500 "other tenant" vectors, each
> a real embedding perturbed to a mean cosine of 0.74 from its seed — near
> enough to compete, which is the case that hurts. Tenants at 0.1%, 2%, 20%
> and 78% of rows; 30 queries each (a tenant chunk, lightly perturbed); top-20
> against exact search; HNSW defaults (`m=16`, `ef_search=40`).
>
> **What the planner chooses.** With literal query vectors, as `retrieve.ts`
> binds them, the planner used the owner index plus a sort — exact — for every
> share up to 20%, and HNSW only at 78%. So at this scale filtered queries
> already get exact recall, by plan choice.
>
> **What HNSW does when it is used** (forced for the smaller shares):
>
> | tenant share | `off` | `relaxed_order` | `strict_order` |
> | ------------ | ----- | --------------- | -------------- |
> | 0.1%         | 0.055 | **0.950**       | 0.162          |
> | 2%           | 0.087 | **0.895**       | 0.780          |
> | 20%          | 0.373 | **0.805**       | 0.680          |
> | 78%          | 0.777 | 0.777           | 0.777          |
>
> That is the failure 0027 predicted, and worse than it said: a tiny tenant
> would keep one true neighbour in twenty, with no error anywhere.
> `relaxed_order` never lowered recall, cost 2–36ms, and is inert when the
> planner picks the exact plan. It is set per database in migration 0017.
> `strict_order` is worse at small shares here and was not chosen. The 78% row
> is ordinary HNSW approximation, not filtering, and `ef_search` is its lever;
> left at the default, because no real query in the eval reaches that plan.
>
> `pnpm rag:eval` after the migration is identical per question to the 1d
> baseline, as expected at the eval corpus's size.

> **1c — measured (2026-09-25).** `pnpm rag:eval --label parents`, cracking
> off, fixed pipeline, `RAG_PARENT_ASSEMBLY=true`, corpus now including
> `eval/corpus/records-policy.pdf` (the one document with several chunks per
> section). Section slice (n=3, 2 gating): `section-records-disposal` rank 1 as
> a parent assembled from 4 chunks, `section-records-retention` rank 1 from 2;
> the diagnostic `section-downtime-table` (a text-layer table) is not retrieved
> and does not gate. Single-hop (the control): hit@1 0.941, hit@3 0.941, MRR
> 0.941, **refusal 1.000**, cross-KB leakage 0. Assembly only replaces two or
> more chunks that each already passed the similarity gate, so it cannot turn a
> refusal into an answer, and nothing new is embedded or stored — no re-ingest.
>
> **1g was not completed.** A run of `scope.ts` alone and of neither both scored
> hit@1 0.941 and refusal 1.000 on 2026-09-25; the HyDE-alone and both runs were
> stopped part-way at the owner's request, and the whole-document questions
> they needed were not merged. The 1g criteria stay open (#27).
> _(2026-09-26: closed by removing HyDE instead — see 1g — decision.)_

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

### 1g — decision: HyDE is removed (2026-09-26)

HyDE is deleted, not hidden (#27): `src/lib/rag/hyde.ts`, `RAG_HYDE_ENABLED`,
`RAG_HYDE_MODEL`, the HyDE model job in Settings → Models, the toggle in
Settings → Retrieval & answering, and its step in retrieval. `scope.ts` stays
as the fix for whole-document requests. The reasons:

1. **Refusal risk.** It writes a plausible answer to a question the corpus
   cannot answer, and that answer embeds closer to real passages than the
   question does, pushing similarity **up** on a question that must refuse
   (the parental-leave case above). Refusal accuracy is the strongest
   guarantee this system makes (NFR2); HyDE's failure mode aims at it.
2. **It failed the case it was meant for.** Asked to summarise a document, it
   invented a different document from the title.
3. **Latency.** One generation before the embedding, the search and the
   answer: a median 9.5s, roughly doubling time to first token.
4. **The head-to-head could not run.** `resolveScope` always runs, so "HyDE
   alone" was never selectable, and adding a real `scope.ts` switch to measure
   a feature the evidence already argued against was not worth its cost.
5. **It had stopped being an experiment.** Since 2026-09-26 (`e9dae5a`)
   `RAG_HYDE_ENABLED` was a toggle in Settings, so an admin could turn on a
   feature whose refusal accuracy had never been measured.

What remains is the configuration already measured on 2026-09-25 — `scope.ts`
alone, HyDE off: hit@1 0.941, refusal 1.000. Saved settings rows for the removed
keys (`RAG_HYDE_ENABLED`, `RAG_HYDE_MODEL`, `connection:hyde`) are ignored on
load, not an error. If HyDE is ever revisited it needs its own spec, a real
`scope.ts` switch, and refusal measured before it reaches Settings.

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
- [x] `pnpm rag:eval` after 1d alone, recorded, refusal 1.000 — the A/B under
      _1d — measured on retrieval (2026-09-25)_: refusal 1.000 with and without
- [x] Filtered-ANN recall measured for a small-share tenant, with the
      `hnsw.iterative_scan` decision and its numbers recorded here — _1e —
      measured (2026-09-25)_; `drizzle/0017_hnsw_iterative_scan.sql`
- [x] `pnpm rag:eval` after 1e alone, recorded — identical per question to
      the 1d baseline (hit@1 0.882, MRR 0.912, refusal 1.000, leakage 0)
- [x] A question answered by a whole section retrieves the parent rather than
      three adjacent children — `eval/questions.json` `section-*`: both gating
      questions return an assembled parent at rank 1 (parent@1 2/2, 2026-09-25)
- [x] `pnpm rag:eval` after 1c alone, recorded — single-hop hit@1 0.941,
      MRR 0.941, refusal 1.000, cross-KB leakage 0 (see _1c — measured_)
- [x] ~~HyDE measured alone, `scope.ts` measured alone, and both together, on
      the same questions — the loser removed or disabled with numbers stated~~
      — superseded: HyDE removed without the head-to-head (#27), see _1g —
      decision_
- [x] ~~Refusal accuracy is 1.000 at every one of those checkpoints~~ —
      superseded with the criterion above; the one configuration left
      (`scope.ts` alone) measured refusal 1.000 on 2026-09-25
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
> - **The four `pnpm rag:eval` checkpoints and the refusal-accuracy line.**
>   _(1d, 1e and 1c have since been measured — see 2026-09-25 above; this
>   bullet stands for 1g.)_ 1d
>   was in the tree and **had not been measured**, which is the one thing the
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
