---
id: 0032
title: Settle whether the agentic path should be the default
status: Proposed
release: '—'
created: 2026-09-10
updated: 2026-09-10
---

# 0032 — Settle whether the agentic path should be the default

## Summary

The agentic retrieval loop shipped in [`0029`](0029-agentic-retrieval-loop.md)
behind `RAG_AGENTIC_ENABLED`, default off, and it has stayed there. The recorded
comparison says it is **worse at single-hop retrieval and the only thing that
can answer a follow-up at all** — a genuine trade that nobody has decided,
resting on five questions.

This spec does not build a feature. It makes that decision answerable: grow the
slices that carry it from n=5 to n≈30, re-run `--compare` against the pipeline
as it exists now, and then either flip the default or write down why not.

## Problem / motivation

The numbers, from `eval/results/{baseline,agentic}.json` (recorded 2026-09-07):

| Metric                | Fixed pipeline   | Agentic loop |
| --------------------- | ---------------- | ------------ |
| single-hop hit@1      | **0.941**        | 0.882        |
| single-hop MRR        | **0.941**        | 0.882        |
| follow-up hit@1       | 0.000            | **0.667**    |
| multi-hop full-match  | 0.000            | **1.000**    |
| multi-hop fact recall | 0.500            | **1.000**    |
| refusal accuracy      | 1.000            | 1.000        |
| mean latency          | **not measured** | **11.1s**    |

The latency row is the first thing to fix. The harness times the **agentic pass
only** — `latencyMs` is set inside `agenticRetrieve` and nowhere else — so the
project's own comparison has been citing "~1s" for the fixed path from prose in
`docs/rag.md`, and citing a _median_ in a column beside a genuine _mean_.
Latency is the entire argument against the loop and half of it was never
measured.

Two things make this hard to act on.

**The trade is real, not noise in one direction.** The fixed path is _better_ at
what it was built for and **structurally incapable** of the other two: it embeds
the literal question, so a pronoun retrieves nothing, and it searches once, so a
two-document answer cannot happen. Its 0.000 on follow-ups is not a tuning
failure; it is the behaviour 0029 exists to fix.

**But the evidence is too thin to decide on.** The follow-up slice is **n=3**
and multi-hop is **n=2**. One question moves those by a third and a half
respectively. `docs/rag.md` already says so under Known gaps — "direction real,
magnitude provisional" — and then the project proceeded to leave a default
unset on exactly that basis.

The comparison is also **stale**. It predates document cracking
([`0031`](0031-tables-figures-and-complex-layouts.md)), the loop's budget fixes,
and the `read_figure` tool. Its `config` block records
`maxLoopMs: 15000, maxLoopTokens: 8000` — budgets since shown not to bind.

Meanwhile the flag is doing decision-shaped work. A deployment that never
changes it gets the fixed path forever, including for questions the fixed path
provably cannot answer.

## Goals

- The follow-up and multi-hop slices are large enough that one question does not
  move a metric by a third.
- A recorded `--compare` run against the **current** pipeline, cracking on and
  off.
- A written decision on `RAG_AGENTIC_ENABLED`'s default, with the numbers that
  justify it — including the option "stays off, and here is why".

## Non-goals

- Making the agentic path faster. Latency is a real objection and it is
  [`0027`](0027-agentic-rag-and-document-cracking.md)'s territory, not this
  spec's; this spec measures the trade rather than changing it.
- Adding retrieval capability. Improvements belong in
  [`0033`](0033-retrieval-fundamentals.md) and must be measured **after** this
  baseline, not folded into it.
- Changing what the harness measures about **quality**. hit@k, MRR, refusal
  accuracy and the cross-KB leakage checks stay exactly as they are; a decision
  taken against a moved yardstick is not a decision. Cost reporting is a
  different matter — see FR8, which exists because NFR3 cannot be met without
  it.

## Requirements

### Functional

- **FR1** — The `followup` slice reaches **n ≥ 15**, spanning at least: a
  pronoun ("it", "that one"), an elided subject ("and the deadline?"), a
  correction ("no, the other building"), and a follow-up whose referent is two
  turns back rather than one.
- **FR2** — The `multi-hop` slice reaches **n ≥ 10**, spanning: two facts in one
  document, two facts across two documents, and a fact that requires a figure or
  table plus prose.

  > **Ten, not fifteen, and why.** The corpus holds ~52 sentence-like facts
  > across 17 pages. A follow-up needs one document, so 15 is comfortable there.
  > A multi-hop needs two facts that genuinely cannot be answered from one
  > chunk, and those are scarcer. Pushing to 15 against FR3 would mean
  > manufacturing questions that are nominally two-hop and actually single-hop,
  > which inflates the metric instead of measuring anything. Ten is enough that
  > one question moves it by a tenth rather than a half.

- **FR3** — New questions are drawn from the **existing corpus**. Adding
  documents changes the retrieval pool and would make the new numbers
  incomparable with the recorded baseline.
- **FR4** — At least three follow-ups and three multi-hops are `answerable:
false`, so the refusal gate covers the new slices too.
- **FR5** — A recorded `pnpm rag:eval --compare` run against the current
  pipeline, with cracking **off**, saved as the new reference.
- **FR6** — The same run with cracking **on**, so the interaction between the
  loop and figure reading is measured rather than assumed.
- **FR7** — A decision recorded in this spec: the default `RAG_AGENTIC_ENABLED`
  becomes `true`, or stays `false` with the reason stated in numbers.
- **FR8** — The harness times the **fixed** pass as well as the agentic one and
  reports cost for both. Without this, NFR3 is unsatisfiable and the comparison
  table keeps quoting a number nobody measured.

### Non-functional

- **NFR1** — The single-hop slice stays **byte-for-byte unchanged**. It is the
  only thing tying every measurement in this project back to the original
  baseline, and it has already survived four specs.
- **NFR2** — The refusal-accuracy gate holds at 1.000 across every run. A
  decision bought with a refusal regression is not a decision, it is a
  regression.
- **NFR3** — Cost is reported alongside quality. Mean latency, searches and
  tokens per question are the entire case against the loop and must appear
  beside the case for it.

## Design / approach

### Where the questions come from

`eval/questions.json` already carries `turns` for follow-ups and
`answerDocuments` for multi-hop. Nothing structural is needed — this is
authoring, and it should be authoring against `eval/make-corpus.mjs` so every
new question's ground truth is checkable in source rather than remembered.

The corpus now spans six documents including
`site-operations-report`, `maintenance-log` and `plant-services-manual`, which
carry tables, a chart, a flow diagram and a scanned page. That is enough surface
for FR2's third case (figure or table plus prose) without adding documents.

### The comparison to run

```
pnpm rag:eval --compare                          # cracking off, the reference
RAG_CRACK_ENABLED=true pnpm rag:eval --compare   # cracking on
```

Both saved. The second matters because `read_figure` only exists inside the
loop — with cracking on, the agentic path gains a capability the fixed path
cannot have at all, which may change the trade rather than merely scaling it.

### What "decide" means

Three outcomes are legitimate and the spec must not prejudge which:

1. **Default on.** The follow-up and multi-hop gains hold at n≈15 and the
   single-hop cost stays inside noise.
2. **Default off, permanently.** The latency is disqualifying for the
   boilerplate's audience regardless of quality — a defensible answer that
   should then be written into `docs/rag.md` as a recommendation, not left as an
   unset flag.
3. **Default off, conditionally.** The gains are real but only for corpora with
   conversational use; the docs say when to turn it on.

### What a reviewer must not get wrong

**The single-hop drop must not be explained away.** 0.941 → 0.882 is one
question, and the temptation is to call it noise and move on. It is one question
out of seventeen on a slice that has been stable across four specs — small, but
the only slice with enough history to trust. If the decision is "on", that
regression is being accepted deliberately and should be named as accepted, not
rounded off.

## Acceptance criteria

- [ ] `followup` questions number ≥ 15 and cover the four reference kinds in
      FR1 — `eval/questions.json`
- [ ] `multi-hop` questions number ≥ 15 and cover the three shapes in FR2 —
      `eval/questions.json`
- [ ] Every new question's answer is traceable to source — `eval/make-corpus.mjs`
      for the generated PDFs, and a committed generator for
      `eval/corpus-assets/appendix-b-scan.jpg`, whose facts currently exist only
      inside a binary and are reproducible from nothing
- [ ] The single-hop slice is unchanged — `git diff` shows no edit to the
      original 20
- [ ] A `--compare` run with cracking off is recorded, with the numbers pasted
      into this spec
- [ ] A `--compare` run with cracking on is recorded, likewise
- [ ] Refusal accuracy is 1.000 in all four passes (fixed and agentic, cracking
      on and off)
- [ ] This spec states the decision and the numbers behind it
- [ ] `docs/rag.md` reflects the decision, whichever way it went

## Security & privacy

None. This adds evaluation questions and runs the existing harness. The eval
user and corpus are already isolated from real accounts.

## Alternatives considered

- **Flip the default on the numbers we have.** Tempting, and the follow-up gain
  is large. But n=3 is not a basis for a default that every downstream
  deployment inherits, and this project's own history — a refusal regression
  that appeared while every other metric improved — is the argument against
  trusting a small favourable slice.
- **Add documents as well as questions.** Would make the corpus more realistic
  and the numbers incomparable. Realism is worth having; it is worth having in a
  separate change, measured against a baseline recorded on the same pool.
- **Judge answer quality with a model.** More faithful to what users experience
  and it introduces a scorer whose own variance is unmeasured. `--answers`
  (spec 0031) already covers the narrow, deterministic version of this.
- **Leave the flag and document the trade.** The status quo. It is defensible
  for a boilerplate — but only as a stated recommendation, which is outcome 2
  above, not as an unset default nobody chose.

## Out of scope / future

- Latency work on the agentic path.
- A larger or more realistic corpus.
- Per-user or per-deployment budgets, still open from 0029.

## References

- [`0029`](0029-agentic-retrieval-loop.md) — the loop, its budgets and the
  refusal invariant.
- [`0031`](0031-tables-figures-and-complex-layouts.md) — `read_figure`, which
  only exists inside the loop.
- Recorded numbers: `eval/results/baseline.json` and `eval/results/agentic.json`
  (2026-09-07), reproducible with `pnpm rag:eval --compare`.
- `docs/rag.md` — Known gaps already names the n=3/n=2 problem this spec fixes.
