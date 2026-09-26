---
id: 0043
title: Plan only when it pays
status: Proposed
release: '—'
created: 2026-09-26
updated: 2026-09-26
---

# 0043 — Plan only when it pays

Tracked in [#85](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/85)
(route), [#86](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/86)
(confident stop), [#87](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/87)
(per-call cap), and
[#84](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/84)
(planner reasoning off). The eval and the defaults are
[#88](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/88).

## Summary

The agentic planner runs on every question. Measured, it only helps two kinds:
follow-ups that lean on the conversation, and questions that ask two things at
once. For everything else it adds about 11 seconds and does slightly worse,
and on NVIDIA's free tier it times out on most questions. This spec runs the
planner only where it pays, skips its second decision when the first search
already found a strong match, and gives up on a stalled call after a few
seconds instead of the whole loop budget.

## Problem / motivation

- **Measured value (spec 0032, 2026-09-11).** Follow-ups: 1/16 found without
  the planner, 15/16 with it. Standalone questions: 0.882 without, 0.824 with,
  at ~0.15 s against ~11 s before writing starts. Multi-part questions gained
  in spec 0029's run (0 → 1.000, small sample) and were never measured to
  completion.
- **Measured cost (Observability, 2026-09-26).** 15 agentic questions: 14
  ended with the planner timed out or failing and falling back to a plain
  search; answers took 27 s on average. The time-outs cluster on the second
  decision ("enough to answer, or search again?"), which reads the passages
  found and took 8.9–9.5 s, running out the 15 s loop budget. On the free
  tier a single planner call has been seen at 38 s.
- The fallback is good: with the planner down throughout (2026-09-25 eval),
  follow-ups still scored 0.563 against 0.062 for the plain pipeline.

## Goals

- Most questions make no planner call.
- A follow-up or a multi-part question makes one short planner call in the
  usual case.
- A stalled planner costs a few seconds, not fifteen, and the question is
  still answered.
- Refusal accuracy stays 1.000; follow-up and multi-part recall keep their
  gains.

## Non-goals

- Changing the planner's prompt or tools.
- Parallel multi-query retrieval for multi-part questions (a later step if
  the multi-part slice needs it).
- Leaving NVIDIA's free tier: provider choice stays in Settings.

## Requirements

### Functional

- **FR1 — Route.** Before retrieval, a deterministic router (no model call)
  sends a question to the planner only if it is a **follow-up** (the
  conversation has earlier turns, and the question refers back: a pronoun or
  determiner such as _it_, _that_, _they_, _there_; a lead such as _and_,
  _what about_, _no, I meant_; or six words or fewer) or **multi-part** (two
  questions joined by _and_ / _or_, more than one question mark, or words
  such as _compare_, _each_, _both_, _separately_, _which … more_). Every
  other question goes straight to the fixed pipeline. When unsure, it plans:
  a missed follow-up costs recall, a needless plan costs seconds.
- **FR2 — Confident stop.** After the planner's first search, if the best
  passage's similarity is at least `RAG_AGENTIC_CONFIDENT_SIMILARITY`, the
  loop ends without a second planner decision (termination `confident`).
  Not for multi-part questions, which need both halves.
- **FR3 — Per-call cap.** Each planner call gets at most
  `RAG_PLANNER_CALL_MS` (and never more than the loop's remaining budget).
  A capped call before any search falls back as an outage does today; after a
  search it ends the loop with the evidence in hand (termination
  `planner-slow`).
- **FR4 — Settings.** `RAG_AGENTIC_ROUTE` (`adaptive` | `always`),
  `RAG_AGENTIC_CONFIDENT_SIMILARITY` (0–1; `1` turns FR2 off),
  `RAG_PLANNER_CALL_MS`; all in `src/lib/ai-env.ts`, so Settings can save
  them. `always` is today's behaviour exactly.
- **FR5 — Visible.** Runs record why a question did or did not plan; the
  activity drawer and Overview name the new terminations in plain words.

### Non-functional

- **NFR1** — The router is pure and unit-tested against every eval question:
  all follow-ups and all multi-part questions plan, and all single-hop
  questions do not.
- **NFR2** — `pnpm rag:eval --compare` applies the same router to its agentic
  pass, so the eval measures what the app does.

## Design / approach

- `src/lib/rag/plan-route.ts` — `planRoute(question, turns)` returns
  `{ plan: boolean, reason: 'follow-up' | 'multi-part' | 'standalone' }`. Pure.
- `src/app/api/chat/route.ts` — `gatherEvidence` reads the prior turns first,
  then takes the agentic path only when `RAG_AGENTIC_ROUTE` is `always` or
  the router says plan. The `retrieve` step records the route.
- `src/lib/rag/agentic.ts` — `LoopBudget` gains `confidentSimilarity` and
  `planCallMs`; `callSignal` takes the smaller of the per-call cap and the
  remaining budget; after a search, a confident best match finishes with
  `confident`. `agentic-run.ts` passes `multiPart` so FR2 is skipped for it.
- `eval/run.ts` — the agentic pass routes the same way; a standalone
  question is scored on the fixed pipeline, as the app would answer it.

## Acceptance criteria

- [x] NFR1: `tests/unit/rag-plan-route.test.ts` classifies all 66 eval
      questions as intended
- [x] FR2, FR3: loop tests for `confident` and `planner-slow`
- [ ] `pnpm rag:eval --compare` with `adaptive` against `always`: refusal
      accuracy 1.000; follow-up and multi-part recall not lower; single-hop
      not lower; planner calls and latency per question recorded here
- [ ] #84 decided in the same run: reasoning `off` against `on`
- [ ] Defaults set from that run, and recorded here with the numbers

## Security & privacy

No change: routing reads the question and the conversation the request
already holds.

## Alternatives considered

- **Turn agentic off.** Fastest, but follow-ups drop to about 1 in 16.
- **Raise `RAG_MAX_LOOP_MS`.** Fewer time-outs, slower answers everywhere.
- **A model-based router.** Costs the round trip this spec removes; the
  regex router already classifies every eval question correctly.
- **A separate rewrite call for follow-ups.** Spec 0029 measured it and folded
  it into the planner's first call; FR1–FR3 keep that and remove the rest.

## References

- Specs 0029 (agentic loop), 0032 (the default), 0042 (the measurements).
- Adaptive-RAG and Corrective RAG: escalate only when the question or the
  retrieval result calls for it.
