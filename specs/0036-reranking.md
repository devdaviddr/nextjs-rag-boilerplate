---
id: 0036
title: Reranking, without waiting for the account
status: Proposed
release: '—'
created: 2026-09-10
updated: 2026-09-10
---

# 0036 — Reranking, without waiting for the account

## Summary

A cross-encoder reranker is normally the highest-precision change available to a
retrieval system, and this one has never had it.
[`0027`](0027-agentic-rag-and-document-cracking.md) filed it as **blocked**
because `nvidia/llama-3.2-nv-rerankqa-1b-v2` returns 404 on this account, and
that has been the project's position ever since.

That framing is too absolute. 0027 itself listed **three** options and only one
of them depends on the account. This spec picks up the other two, and it does so
now because 0027's own condition for revisiting has been met.

## Problem / motivation

### The deferral's condition has been satisfied

0027 §1f recommended deferring with a specific test:

> **Recommendation: defer.** Hybrid + contextual headers should be measured
> first; they may close enough of the gap that reranking is not worth its cost
> here.

They were measured. Contextual headers and hybrid retrieval took hit@1 from
0.824 to **0.941** — a real gain, and it did not close the gap. The condition
attached to the deferral has been discharged and the deferral has simply
persisted, because "blocked" is stickier than "deferred pending a measurement".

### There is a specific, measured defect that only reranking fixes properly

From `docs/rag.md`'s Known gaps, and 0027's own analysis:

> An exact identifier below the similarity floor still refuses. A lexical hit is
> not allowed to admit a chunk on its own, because on the evaluation corpus **no
> lexical-rank threshold separates true from false positives**: _"How much
> parental leave am I entitled to?"_ — which the corpus cannot answer — scores
> **0.60** on `leave`, higher than every genuine identifier query at **0.30**.
> Enabling that bypass took refusal accuracy from 1.0 to **0.0**.

So the system currently refuses questions it could answer, and it does so
deliberately, because the only available admission signal is worse than useless.
0027 names the two principled fixes: **reranking, or IDF-aware gating**. Neither
has been attempted. The conservative refusal is the right behaviour given the
alternatives, but it is a workaround, not a resolution.

### Two of the three options were never explored

| Option                   | Blocked by the account?  | Explored? |
| ------------------------ | ------------------------ | --------- |
| NIM reranker endpoint    | **Yes** — none reachable | n/a       |
| Local ONNX cross-encoder | No                       | **No**    |
| LLM-as-reranker          | No                       | **No**    |

Re-probed 2026-09-10: 80 models on the account, **nothing** matching `rerank`,
`cross`, `score` or `rank`. That rules out one row of that table, and the
project has been treating it as ruling out the feature.

The LLM-as-reranker option carries an explicit prior rejection from
[`0025`](0025-rag-knowledge-base-and-chat.md): _"Not faked with a second LLM
pass."_ That was right at the time — the pipeline was one embedding call and one
completion, and a second model pass per query would have doubled its cost
profile. **The premise has since changed.** The agentic loop now makes up to
three planner calls plus a verification pass per question as a matter of course.
A reranking call is no longer a categorical change to what a query costs; it is
one more call among several. The rejection deserves re-examination rather than
inheritance.

## Goals

- Retrieval precision improves measurably, or the attempt is recorded as having
  failed and reranking is closed out with numbers.
- The below-floor identifier case is answerable without giving up refusal
  accuracy.
- Reranking is optional and failure-open: a deployment without it behaves
  exactly as today.

## Non-goals

- Waiting for a NIM reranker. If one appears it becomes a third backend behind
  the same interface, but this spec does not depend on it.
- Fine-tuning a reranker on the corpus.
- Replacing hybrid retrieval. A reranker re-scores what RRF surfaced; it does
  not choose candidates.

## Requirements

### Functional

- **FR1** — A reranking stage sits between fusion and the similarity gate,
  re-scoring the top `RAG_RERANK_CANDIDATES` and reordering them.
- **FR2** — At least one backend that does **not** depend on the NIM account is
  implemented, behind an interface a NIM reranker could later satisfy.
- **FR3** — Reranking is **failure-open**. A backend that errors, times out or
  is unavailable leaves the RRF order untouched. A failed rerank must never turn
  an answerable question into a refusal.
- **FR4** — Off by default, same posture as `RAG_AGENTIC_ENABLED` and
  `RAG_CRACK_ENABLED`.
- **FR5** — The below-floor identifier case is re-examined: with reranking on, a
  chunk carrying an exact identifier may be admitted on the reranker's score
  where a lexical rank alone was never allowed to admit it.
- **FR6** — The reranker's score is recorded on the retrieved chunk, so the
  evaluation harness and the trace can show what it changed.

### Non-functional

- **NFR1** — Refusal accuracy holds at **1.000**. This is the requirement most
  at risk: FR5 is explicitly about admitting chunks the floor currently rejects,
  and the last attempt at that (a lexical bypass) took refusal from 1.0 to 0.0.
- **NFR2** — Reranking adds at most one round trip per query, and its latency is
  reported beside its quality.
- **NFR3** — A local backend must not require a sidecar container. The
  single-container deployment story is load-bearing for this boilerplate.
- **NFR4** — Reranking runs on the query path only. It must never be on the
  ingestion path.

## Design / approach

### Where it goes

`retrieveForOwner` fuses two channels with RRF and then applies
`RAG_MIN_SIMILARITY`. Reranking belongs **between** those two steps: fusion
chooses candidates, the reranker re-scores them, the gate decides what survives.
Putting it after the gate would rerank a list the gate has already truncated,
which is the one arrangement that cannot help.

### Backend 1 — local ONNX cross-encoder

`bge-reranker-base` or similar via ONNX Runtime, in-process. No API dependency,
no rate limit, no data leaving the deployment — which is a real feature for
anyone self-hosting a document corpus, and this boilerplate's audience largely
is.

0027 counted "adds a dependency and CPU cost" against it. That objection is
weaker now: [`0031`](0031-tables-figures-and-complex-layouts.md) already added
`@napi-rs/canvas`, a native addon, with `serverExternalPackages` and standalone
tracing worked out. The path for shipping a native dependency in this project is
no longer unknown.

The genuine cost is CPU per query and image size. Both are measurable before
committing, and NFR3 rules out the sidecar escape hatch.

### Backend 2 — LLM-as-reranker

Score the fused candidates in one completion against the configured chat or
planner model. Cheap to implement, spends the same rate-limited budget the
answer needs, and inherits 0025's objection — which this spec argues has expired
rather than been overturned. Worth implementing mainly as a **comparison
baseline**: if a 1B local cross-encoder beats a 30B model at this, that is worth
knowing and is not obvious in advance.

### FR5 — the below-floor case, carefully

This is the part that can break refusal.

Today: a lexical hit cannot admit a chunk, because lexical rank does not
separate true from false positives — the unanswerable parental-leave question
outscored every genuine identifier query.

The hypothesis is that a **cross-encoder** does separate them, because it reads
question and passage together rather than counting term overlap. If it does, an
identifier query can be admitted on its score. If it does not, FR5 is abandoned
and the conservative refusal stands — that is a legitimate outcome and NFR1
outranks FR5.

### What a reviewer must not get wrong

**A reranker that improves hit@1 and costs refusal accuracy is a regression, and
it will not look like one.** Every quality metric will move up while the system
quietly starts answering questions the corpus cannot answer. This project has
already seen exactly that shape once — the agentic floor-step measurement, where
refusal fell from 1.000 to 0.667 while everything else improved. NFR1 is not a
formality; it is the reason the gate exists.

## Acceptance criteria

- [ ] A reranking stage exists between RRF fusion and the similarity gate, off
      by default — `src/lib/rag/retrieve.ts`
- [ ] A backend independent of the NIM account is implemented behind an
      interface a NIM reranker could satisfy
- [ ] A backend that throws, times out or is absent leaves RRF order unchanged
      and never causes a refusal — `tests/unit/rag-rerank.test.ts`
- [ ] `pnpm rag:eval` with reranking on: hit@1 and MRR recorded against the
      current baseline
- [ ] **Refusal accuracy is 1.000** with reranking on
- [ ] Mean added latency per query recorded beside the quality numbers
- [ ] The below-floor identifier case is measured, and FR5 is either implemented
      with refusal held at 1.000 or explicitly abandoned with the numbers stated
      here
- [ ] If both backends are implemented, they are compared on the same questions
      and the loser is removed or left off with numbers
- [ ] `docs/rag.md`'s "No reranking" gap is rewritten to describe what exists
- [ ] 0027's tracker row for 1f is updated from "Blocked" to reflect the outcome

## Security & privacy

A **local** backend is a privacy improvement: candidate passages are re-scored
in-process rather than sent anywhere. For a self-hosted document corpus that is
a meaningful difference and worth stating in `docs/rag.md`.

An **LLM-as-reranker** backend sends retrieved passages to the configured
endpoint. That is already true of every answered question, so it is not a new
disclosure — but it does mean passages that would have been _filtered out_ by
the gate are now sent, which is a small widening.

Reranker input is retrieved document text, i.e. untrusted content. A scoring
call must not be promptable into doing anything but scoring, and its output must
be parsed as a score rather than trusted as an instruction — the same posture
`verify.ts` takes.

## Alternatives considered

- **Keep waiting for a NIM reranker.** The status quo since 2026-09-07. It makes
  the project's most valuable improvement contingent on a vendor decision nobody
  here controls, when two viable paths need no vendor at all.
- **IDF-aware gating instead.** 0027's other named fix for the below-floor case,
  and genuinely cheaper — no model, no latency. It addresses only that one
  symptom, not retrieval precision generally. Worth doing _as well_, and it is a
  reasonable fallback if both reranker backends disappoint.
- **Raise `RAG_MIN_SIMILARITY` and admit lexical hits above it.** Measured and
  rejected in 0027: true positives on this corpus score 0.41–0.62, so a floor
  above the 0.60 false positive discards real answers.
- **Do nothing; hybrid is good enough at 0.941.** Defensible for the current
  corpus, which is six small documents. The gap 0027 identified is a _precision_
  gap that grows with corpus size, and 0.941 on 17 questions is not evidence
  about a thousand documents.

## Out of scope / future

- IDF-aware gating as a standalone change.
- Reranking figure chunks by their image rather than their search key — needs a
  multimodal reranker, and the one on the account
  ([`0031`](0031-tables-figures-and-complex-layouts.md)'s probe) does not work.
- Caching rerank scores across repeated questions.

## References

- [`0027`](0027-agentic-rag-and-document-cracking.md) §1f — the three options,
  the deferral, and the condition attached to it.
- [`0025`](0025-rag-knowledge-base-and-chat.md) — "Not faked with a second LLM
  pass", the prior rejection this spec argues has expired.
- `docs/rag.md` — Known gaps: "No reranking", and the below-floor identifier
  case with its measured scores.
- Account re-probed 2026-09-10: 80 models, nothing matching `rerank`, `cross`,
  `score` or `rank`.
