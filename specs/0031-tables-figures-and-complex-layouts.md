---
id: 0031
title: Index tables, figures and complex layouts
status: Proposed
release: '—'
created: 2026-09-10
updated: 2026-09-10
---

# 0031 — Index tables, figures and complex layouts

## Summary

Ingestion today reduces every PDF to one plain string per page, so a table
becomes a run of unassociated numbers, a chart contributes nothing at all, and a
scanned page is refused. This spec replaces that single call with a **routed,
budgeted cracking pipeline**: cheap local triage decides which pages need help,
`nvidia/nemotron-parse` returns typed and boxed elements for the ones that do,
and a deterministic normalisation stage repairs the parser's own defects before
chunking. Figures are indexed by a **search key** — their caption where one
exists, a qualitative description where none does — and the pixels are read
**at answer time**, by a vision model that has the question in hand, through a
new `read_figure` tool on the [`0029`](0029-agentic-retrieval-loop.md) loop.

The split between those two jobs is the whole spec. A number read off a chart
during ingestion is a guess nobody asked for; the same number read when a
question is on the table is evidence.

## Problem / motivation

`src/lib/rag/extract.ts` calls `extractText(pdf, { mergePages: false })` and
hands the result to `chunkPages`. That one call sets the ceiling on everything
downstream, and it loses four things measurably.

Probed against the live account on **2026-09-10** with a generated page carrying
a merged-cell table, a bar chart, two-column body text and a header/footer. What
`ingest.ts` sees today:

```
"Regional Performance Review\nThe northern division continued its recovery…\n
 Quarterly Revenue by Region\nRegion Q1 Q2 Q3\nNorth 412 388 501\n
 South 295 301 298\nEast 178 210 265\n
 Confidential — Internal Use Only — Page 1 of 12"
```

- **Tables lose column association.** `North 412 388 501` is recoverable by a
  human and not by an embedding. Merged headers are gone entirely.
- **Figures contribute nothing.** Not degraded — absent. A page whose content is
  a chart is invisible to search.
- **Headers and footers are inline**, so "Confidential — Page 1 of 12" is
  embedded into a chunk and dilutes it.
- **Headings are per-page, not per-section.** `detectHeading` takes the first
  line of the page and stamps it onto every chunk on it. On the page above, the
  revenue table is labelled "Regional Performance Review" when its actual owning
  header is "Quarterly Revenue by Region" — and that wrong heading goes into
  `buildEmbeddingText`, so it reaches the vector.

Scanned pages are worse than degraded. `isImageOnly` averages characters per
page across the **whole document**, so a 40-page text report with a scanned
appendix ingests reporting success while the appendix silently does not exist.

### What one `nemotron-parse` call returns instead

Same page, rendered to PNG. The response is a `tool_calls` payload
(`markdown_bbox`) of typed, boxed elements:

```
Page-header  (0.031,0.024)-(0.357,0.033)  ACME HOLDINGS · INTERNAL · FY26…
Title        (0.031,0.051)-(0.362,0.070)  ## Section 7 — Plant Utilisation
Text         (0.031,0.089)-(0.484,0.124)  Utilisation at the Ballarat plant…
Text         (0.513,0.079)-(0.965,0.114)  Geelong remained the constraint…
Table        (0.034,0.164)-(0.327,0.267)  \begin{tabular}{ccccc}
                                          \multirow{2}{*}{**Plant**} &
                                          \multicolumn{2}{c}{**Utilisation %**}…
Picture      (0.035,0.301)-(0.489,0.454)  peak: Geelong furnace outage 400 0
                                          Q1 Q2 Q3 Q4 Q5
Caption      (0.031,0.359)-(0.519,0.387)  Figure 7.2: Unplanned downtime by…
Page-footer  (0.031,0.485)-(0.238,0.493)  Confidential — Page 63 of 214 — Rev 3
```

542 tokens for a dense page, in seconds. Merged cells survive as `\multirow` and
`\multicolumn`. Headers and footers are typed, so removing them is free.
`Picture` gives the figure's box but only its stray axis labels — the data is
not extracted, which is what makes the answer-time path necessary rather than
optional.

### Three defects in that output the pipeline must absorb

Measured on the same response, not hypothesised:

1. **Output order is not reading order.** The `Page-footer` (ymin 0.485) came
   back _before_ the `Table` (ymin 0.164). Order must be reconstructed from
   boxes.
2. **Duplicate and degenerate elements.** The figure caption appeared three
   times; one copy had an inverted box (`xmin 0.031 > xmax 0.022`).
3. **Chart values are confidently wrong.** Ground truth from the source SVG was
   Q1 215 / Q2 308 / Q3 363 / Q4 138 / Q5 92. `llama-3.2-11b-vision-instruct`
   returned 280 / 360 / 380 / 160 / 120 — every value an overestimate of 15–30%,
   produced _after_ being instructed to say so rather than guess. It took 40s.
   `llama-3.2-90b-vision-instruct` did not return inside 5 minutes.

Defect 3 is why this spec forbids transcribing figures at ingestion. A wrong
number that enters the index is indistinguishable from a right one forever
after, and the citation machinery in `src/lib/rag/verify.ts` would confirm it as
supported, because the chunk really does say 280.

### Landscape pages and diagrams, verified separately

A second probe on 2026-09-10 put a **landscape** page carrying a flowchart-style
diagram and a five-column table with both `rowspan` and `colspan` through the
same path:

- **Orientation is not a special case.** Six clean elements in 2.8s; the merged
  headers survived intact. Boxes are page-relative, so a landscape page differs
  from a portrait one only in aspect ratio. (Pages carrying a `/Rotate`
  attribute are _not_ covered by this and remain untested — see Out of scope.)
- **A diagram parses to labels, not topology.** The `Picture` element returned
  `Upload PDF`, `Triage (per page)`, `Text layer`, `Parse image`, `Normalise` —
  the boxes' text as an unordered bag, with `scanned` misread as `scansel`, and
  no arrows or relationships. That is enough to make the diagram _findable_ and
  nothing more, which is exactly the division of labour FR6 and FR9 describe.
- **Answer time reads the topology correctly, and quickly.** Asked _"after
  Triage, if a page is scanned, which box does it go to, and where next?"_
  against the cropped region, the vision model answered "Parse image, then
  Normalise" — correct — in **4.0s**, against the 40s the same model took to
  describe the earlier chart blind.

That last figure is the strongest evidence for the answer-time split: a narrow
question against a small crop is an order of magnitude faster than blind
description _and_ it was right, where blind description was wrong.

### `read_figure`, and the one thing a prompt could not fix

Built and measured 2026-09-10 against the corpus's chart (five bars, quarter
labels, **no axis values printed at all**):

| asked                                                              | answer                        |                   |
| ------------------------------------------------------------------ | ----------------------------- | ----------------- |
| "which box does a scanned page go to, and where next?" (flowchart) | "Parse image, then Normalise" | ✅ correct, 4.0s  |
| "which quarter has the tallest bar?"                               | "Q3"                          | ✅ correct        |
| "…and roughly what value does it reach?"                           | "approximately 90"            | ❌ true value 363 |

The relational answers are right. The quantitative one is not, and **three
prompt phrasings produced the identical wrong number** — including one that
handed the model the complete list of text printed on the figure and told it a
number may only be stated if it appears there. A prompt does not hold this line.

So the guard is deterministic instead, in the spirit of `verify.ts` stripping
unsupported sentences: `redactUnlabelledNumbers` compares every number in the
reading against the text the parser extracted from the figure, and replaces any
that was never printed with `[unlabelled]`. It redacts in place rather than
dropping the sentence, because the relational half is usually correct and worth
keeping — the same reading that invented 90 correctly identified Q3.

    before   "The tallest bar is Q3, and it reaches a value of approximately 90."
    after    "The tallest bar is Q3, and it reaches a value of [unlabelled]."

**What this means for what the feature can claim.** `read_figure` makes a
figure's _structure_ readable — which bar, which box, what connects to what,
what the labels say. It does not make an unlabelled chart quantitative, and the
redaction is what stops it pretending otherwise. A question whose answer is a
number nobody wrote down still cannot be answered from the document, which is
the correct outcome and the same one the spec started from.

## Goals

- A PDF containing tables, figures, multi-column layout or scanned pages is
  **indexed usefully**, not refused and not silently reduced.
- A table is retrievable as a table, with its columns and merged headers intact,
  and is never split across chunks.
- A figure is **findable** by what it is about, and its actual content is read
  from pixels when — and only when — a question needs it.
- Cracking is bounded by explicit budgets and **degrades rather than fails** when
  they are exhausted, on a rate-limited free tier.
- Existing clean-text documents cost exactly what they cost today: zero extra
  API calls.

## Non-goals

- **Transcribing figures at ingestion.** Explicitly rejected on the measurement
  above, not deferred.
- Replacing the dense/lexical retrieval design. Retrieval keeps the shape
  [`0028`](0028-independent-knowledge-bases.md) and
  [`0027`](0027-agentic-rag-and-document-cracking.md) gave it.
- Multi-vector / late-interaction page retrieval (ColPali-style). See
  **Alternatives**.
- Non-PDF formats (`.docx`, `.html`, `.csv`) — orthogonal, cheaper, separate.
- A worker queue. The no-queue stance from [`0007`](0007-file-uploads.md) holds;
  this spec adds per-page progress instead.
- Reranking. Still no reranker on this account (re-probed 2026-09-10).

## Requirements

### Functional

- **FR1** — Page routing is per **page**, not per document. A document mixing
  clean text and scanned pages indexes both.
- **FR2** — Pages with a usable text layer take the existing free path. Only
  pages triage marks as `structured`, `image-heavy` or `no-text` spend an API
  call.
- **FR3** — Parsed elements are normalised before chunking: reading order
  reconstructed from bounding boxes, degenerate boxes dropped, duplicates
  deduplicated, `Page-header`/`Page-footer` removed, table markup validated and
  closed if cut off, and captions bound to the `Table` or `Picture` they belong
  to — by **vertical adjacency**, not centre distance, which binds a figure's
  own caption to a nearer table.
- **FR4** — A `Table` element becomes exactly one chunk and is never split. Its
  structure is preserved; merged cells survive.
- **FR5** — Each chunk carries the `Section-header` that actually owns it, not
  the first line of its page.
- **FR6** — A `Picture` above `RAG_CRACK_MIN_FIGURE_AREA` becomes a chunk whose
  embedded text is a **search key**: its bound caption where one exists, and
  otherwise a qualitative description from the vision model.
- **FR7** — A figure description states what the figure shows, its axis labels
  and the direction of any trend. It must **not** contain values read off the
  figure. No number originating from a description may reach an answer.
- **FR8** — Every chunk records its `kind` (`text` | `table` | `figure` | `ocr`)
  and its normalised bounding box.
- **FR9** — The [`0029`](0029-agentic-retrieval-loop.md) loop gains a
  `read_figure` tool. Given a figure chunk it crops that region from the stored
  PDF and passes the image, with the question, to the vision model.
- **FR10** — A citation resolving to a `figure` chunk is presented as a
  description of a figure, never as the document's own words.
- **FR11** — Exhausting a budget degrades: remaining pages take the text-layer
  path, the document still reaches `ready`, and `documents.extraction` records
  what was skipped and why.
- **FR12** — A page that fails to crack never fails the document. It retries
  once at a higher render scale, falls back to its text layer, then is recorded
  as unindexed with a reason.
- **FR13** — Ingestion reports per-page progress, not just a coarse status.

### Non-functional

- **NFR1** — A document whose pages are all clean text issues **zero** parse or
  vision calls. The cost of this feature is paid only by documents that need it.
- **NFR2** — Triage and normalisation are pure functions over data structures —
  no database, no network, no PDF — and are unit-tested as such, matching
  `src/lib/rag/chunk.ts`.
- **NFR3** — All cracking sits behind `RAG_CRACK_ENABLED`, default **off**, in
  the same posture `RAG_AGENTIC_ENABLED` established in 0029.
- **NFR4** — Per-document caps on parse calls, description calls and wall-clock
  are enforced in code, not by convention.
- **NFR5** — Page images are rendered as **PNG**. JPEG is not an accepted
  interchange format here (see Design).
- **NFR6** — Parser and vision output is untrusted input. It is stored and
  retrieved as content, never interpreted as instructions.

## Design / approach

```
                ┌─ per page ────────────────────────────────────────┐
 PDF ─▶ TRIAGE ─┤ clean-text ─────────────▶ text-layer path (free)  ├─▶ NORMALISE
       (free)   │ structured/image/no-text ─▶ render ▶ parse        │     (free)
                └───────────────────────────────────────────────────┘        │
                                                                             ▼
                                           ESCALATE ◀── VERIFY (free) ──▶ chunk ▶ embed
                                          (budgeted)   coverage check
```

### Stage 0 — Triage (`src/lib/rag/triage.ts`, pure, free)

Per page, from `unpdf`: text-layer character count, `extractTextItems` count,
x-clustering of item boxes (column estimate), `extractImages` presence, and the
share of page area covered by text. Classify as `clean-text`, `structured`,
`image-heavy` or `no-text`.

This is the entire cost story (NFR1). On a typical report the parse route fires
on a handful of pages. It also **replaces `isImageOnly`'s document-level
rejection with a per-page decision** (FR1), which on its own fixes the
silently-invisible scanned appendix.

### Stage 1 — Render and parse (`render.ts`, `parse.ts`)

`unpdf`'s `renderPageAsImage` at `RAG_CRACK_RENDER_SCALE`, which needs
`@napi-rs/canvas` — the one new dependency.

**PNG, always.** A JPEG of an identical page scored **0.098** self-similarity
against its PNG when embedded, where two PNG renders of the same page at
different resolutions scored **0.944**. Something in the chain mishandles JPEG
silently. This is NFR5 and it is not a preference.

The parse call is a `/chat/completions` request returning `tool_calls`, so
`src/lib/rag/client.ts` needs nothing new — `createChatCompletion` already
parses that shape for the planner.

### Stage 2 — Normalise (`src/lib/rag/normalize.ts`, pure, free)

The highest-value module in this spec, because it is deterministic, costs
nothing, and is where the three measured parser defects are handled (FR3):

- reconstruct reading order by clustering `xmin` into columns, then ordering by
  `y` within each column — **never trust response order**
- drop boxes where `xmin ≥ xmax` or `ymin ≥ ymax`
- deduplicate on normalised text plus box IoU
- drop `Page-header` and `Page-footer`
- bind each `Caption` to the nearest `Table` or `Picture` by box proximity
- attach the owning `Section-header` to every element (FR5)

Tables keep the parser's structural markup rather than being flattened to
Markdown (FR4): Markdown cannot express `rowspan`/`colspan`, and the merged
headers the parser correctly recovered would be destroyed by the conversion.

### Stage 3 — Verify (free)

Where a text layer exists, measure the fraction of its tokens that survive into
the parse output. Low coverage means the crack dropped content — escalate.
Without a text layer, fall back to element count and area coverage.
Deterministic on purpose: reproducible, and free to run on every page.

### Stage 4 — Escalate (budgeted)

- **Figures with a caption cost nothing.** The caption is the document's own
  words and is ground truth; it becomes the search key directly (FR6). On the
  probed page the caption was recovered in full, so the common case needs no
  vision call at all.
- **Caption-less figures** get one `llama-3.2-11b-vision-instruct` call, capped
  by `RAG_DESCRIBE_MAX_FIGURES`, prompted for qualitative description only and
  explicitly forbidden from reading values (FR7). 40s each — the tightest budget
  in the system.
- **Failed pages** retry once at higher scale, then fall back to the text layer,
  then are recorded as unindexed (FR12).

### Stage 5 — Chunk and embed, element-aware

| kind     | chunking                     | embedded text                                       |
| -------- | ---------------------------- | --------------------------------------------------- |
| `text`   | existing `chunkPages` budget | title — section header — content                    |
| `table`  | **one chunk, never split**   | title — section header — caption — table markup     |
| `figure` | one chunk                    | title — section header — **caption or description** |
| `ocr`    | as `text`                    | title — section header — content                    |

`buildEmbeddingText` already separates embedded text from displayed content, so
a figure's search key never appears in a citation as though it were the
document's words.

### Answer time — the `read_figure` tool (FR9)

The half of this spec that makes figures actually work.

```ts
export const READ_FIGURE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_figure',
    description:
      'Look at a figure, chart or diagram from a document and read what it ' +
      'shows. Call this when a search result is a figure and answering needs ' +
      'a value, label or detail from the image itself.',
    parameters: {
      type: 'object',
      properties: {
        chunkId: { type: 'string', description: 'The figure chunk to read.' },
        question: {
          type: 'string',
          description: 'What to look for in the figure.',
        },
      },
      required: ['chunkId', 'question'],
      additionalProperties: false,
    },
  },
}
```

It resolves the chunk (owner- and knowledge-base-scoped, exactly as
`search_documents` is), fetches the PDF via `getObjectBuffer`, renders the
chunk's page, crops `bbox` with ~1% padding — axis labels sit outside the
detected box — and calls the vision model with the crop and the question.

This inverts the cost curve. Ingest-time description was budgeted at 8 calls per
document at 40s each, spent on every figure whether or not anyone ever asks. At
answer time it is one call, for the one figure that matched, with the question
in hand. Fewer calls, and a model reading a chart to answer a specific question
is a fundamentally easier task than blind transcription.

The tool counts against the loop's existing `maxSearches`, `maxMs` and
`maxTokens` budgets in `src/lib/rag/agentic.ts`. A 40s call against a
`RAG_MAX_LOOP_MS` budget is significant and must be, or the loop will spend its
whole allowance looking at pictures.

### Schema

```
chunks.kind                text   not null default 'text'
chunks.bbox                jsonb  -- normalised 0–1, from parse or extractTextItems
documents.pages_processed  integer
documents.extraction       jsonb  -- route per page, budget spent, pages skipped + why
```

`chunks.bbox` is the **span-level citation highlighting deferred in
[`0026`](0026-chat-first-ux-and-history.md)**, arriving as a side effect. Every
path here forces a re-ingest of existing documents, so it happens in one
migration rather than two.

### Configuration

```
RAG_CRACK_ENABLED=false                                  # NFR3
RAG_CRACK_MAX_PAGES=25                                   # parse calls per document
RAG_CRACK_RENDER_SCALE=2.0
RAG_CRACK_MIN_FIGURE_AREA=0.02
RAG_DESCRIBE_MAX_FIGURES=8                               # caption-less figures only
RAG_PARSE_MODEL=nvidia/nemotron-parse
RAG_VISION_MODEL=meta/llama-3.2-11b-vision-instruct
RAG_READ_FIGURE_ENABLED=false                            # answer-time tool
```

Added to `src/lib/env.ts` _and_ `.env.example`, per the project convention.

### What a reviewer must not get wrong

**A figure's indexed text is a search key, not evidence.** It exists to make the
figure findable and for no other purpose. If a description ever carries a number
and that number reaches an answer, this feature has made the system worse than
it was before — a confident wrong figure, cited, and confirmed as supported by
`verify.ts` because the chunk genuinely says it. FR7 is the requirement the
measurement in **Problem** exists to justify.

## Acceptance criteria

- [x] A page classified `clean-text` requires no parse or vision call, and an
      all-clean document counts zero crackable pages (NFR1) —
      `tests/unit/rag-triage.test.ts`
- [x] A document of entirely clean-text pages issues zero cracking calls
      end to end — `tests/unit/rag-crack.test.ts`, and measured on the corpus:
      3 of 5 documents spent nothing
- [x] Reading order is reconstructed from boxes, not response order; the
      out-of-order `Page-footer` case from **Problem** orders correctly —
      `tests/unit/rag-normalize.test.ts`
- [x] Degenerate boxes (`xmin ≥ xmax`) are dropped and duplicate captions
      deduplicated — `tests/unit/rag-normalize.test.ts`
- [x] `Page-header` / `Page-footer` elements never reach a chunk —
      `tests/unit/rag-normalize.test.ts`
- [x] A table is marked atomic with its merged-cell structure intact, and a
      caption binds to the element it sits against rather than the nearest one
      — `tests/unit/rag-normalize.test.ts`
- [x] Each element carries the heading that precedes it in reading order,
      rather than the page's first line — `tests/unit/rag-normalize.test.ts`
- [x] A captioned figure produces a `figure` chunk with **no** vision call —
      the corpus's chart page indexes as `kind='figure'` with its caption bound
      and zero vision calls; `tests/unit/rag-normalize.test.ts` covers binding
- [x] A number that the figure does not print cannot reach an answer (FR7) —
      `redactUnlabelledNumbers`, `tests/unit/rag-figure.test.ts`; the guard is
      deterministic because three prompt phrasings did not hold it
- [x] `read_figure` refuses a chunk outside the caller's knowledge-base scope,
      with the same filter `search_documents` uses — `resolveFigure` gates on
      `owner_id` AND `knowledge_base_id` AND `kind='figure'`; verified live
      against the eval corpus, where a wrong owner and a wrong knowledge base
      each return `null`
- [x] Exceeding `RAG_CRACK_MAX_PAGES` leaves the document `ready` with the
      shortfall recorded in `documents.extraction` — `tests/unit/rag-crack.test.ts`
- [x] A document with a scanned appendix indexes both its text pages and its
      scanned pages — `maintenance-log` now yields 7 chunks (1 text-layer page,
      6 `kind='ocr'`), and `layout-chiller-warranty` retrieves at rank 1 where
      it previously retrieved nothing at all
- [x] The corpus contains documents the current pipeline provably cannot index,
      and the gap is recorded before it is closed —
      `eval/questions.json` (`type: layout`), `eval/make-corpus.mjs`; numbers
      in the table below, reproducible with `pnpm rag:eval`
- [x] Extending the corpus leaves the single-hop baseline untouched, so the
      recorded numbers stay comparable — hit@1 0.941, MRR 0.941, refusal
      1.000, leakage 0, and the original three PDFs regenerate byte-identical
- [x] `pnpm rag:eval` on the extended corpus shows no regression in refusal
      accuracy (1.000, unchanged) and retrieves the scanned page it previously
      could not — layout hit@1 0.750 → 1.000; see the measurement above for the
      one single-hop reordering that came with it
- [ ] A question whose only answer is a value inside a chart **refuses**,
      rather than returning a described number — needs an answer-level check;
      see the harness note above. The mechanism is in place and unit-tested;
      what is missing is a harness that scores answers rather than retrieval

> **Not verifiable by the retrieval harness (2026-09-10).** "Answers a table
> question the current pipeline cannot" was an acceptance criterion in the first
> draft of this spec and has been removed, because `eval/run.ts` scores which
> chunk came back, not what was said about it. A flattened table and interleaved
> columns both retrieve at rank 1 today. Proving those are fixed needs an
> answer-level assertion the harness does not currently make — listed under
> Out of scope.

### Measured gap, before any cracking (2026-09-10)

The corpus was extended with `site-operations-report` (row-major two columns, a
merged-cell table, a landscape chart page) and `maintenance-log` (a text page
followed by a scanned one), plus five `layout` questions. Measured with
`pnpm rag:eval` (its results directory is git-ignored, so the numbers are
recorded here rather than linked):

| question                            | retrieved            | what it proves                                                                                                                                             |
| ----------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout-chiller-warranty`           | **nothing**          | The scanned page produced no chunks at all. The document ingested and reported success — FR1's silent appendix, demonstrated.                              |
| `layout-q2-downtime-hours`          | figure page at 0.531 | Above the 0.35 floor, so the system will **not** refuse. The guard against inventing a chart value has to live in the answer path (FR7), not in retrieval. |
| `layout-lift-capacity-north`        | rank 1               | Passes retrieval while the chunk reads `…capacity is 1600 Its rated capacity is unchanged at / kilograms. 1000 kilograms.`                                 |
| `layout-geelong-unplanned-downtime` | rank 1               | Passes retrieval while the chunk is a flattened table whose `388` has lost its column header.                                                              |
| `layout-downtime-spike-quarter`     | rank 1               | The caption case — already free, and the reason FR6 prefers a caption over a vision call.                                                                  |

Single-hop metrics were **unchanged** by the extension (hit@1 0.941, MRR 0.941,
refusal 1.000, cross-KB leakage 0), which is what keeps the recorded baseline
comparable.

### Measured again, with cracking on (2026-09-10)

Same corpus, same questions, `RAG_CRACK_ENABLED=true`:

| metric                 | cracking off | cracking on |                                                                       |
| ---------------------- | ------------ | ----------- | --------------------------------------------------------------------- |
| **layout** hit@1 / MRR | 0.750        | **1.000**   | every answerable layout question retrieves, the scanned page included |
| single-hop hit@1       | 0.941        | 0.882       | one question slipped rank 1 → 2                                       |
| single-hop hit@3       | 0.941        | 0.941       | unchanged                                                             |
| single-hop MRR         | 0.941        | 0.912       |                                                                       |
| refusal accuracy       | 1.000        | 1.000       | unchanged; the project's hard gate still passes                       |
| cross-KB leakage       | 0            | 0           | unchanged                                                             |

Cost across the whole five-document corpus: **4 parse calls**. The three
clean-text documents spent nothing, which is NFR1 holding in practice rather
than in principle.

**The single-hop slip is real and is reported rather than smoothed.**
`notice-period` ("What is the notice period after probation?") fell from rank 1
to rank 2 behind `employment-contract` page 1, which reads _"Either party may
end the appointment during probation with one week notice."_ — a chunk that
genuinely contains both "probation" and "notice". The two were always close;
cracking added nine chunks to the corpus, which changed the hybrid candidate
pool enough to tip a near-tie. Neither chunk's text changed. hit@3 is
unchanged, so nothing became unreachable, and on a 17-question set one position
is 5.9% — this is a reordering within noise, not a retrieval regression, but it
is a number that moved and it is recorded as one.

> **The harness cannot see two of these gaps.** It scores retrieval, and the
> last three rows above _pass_ retrieval while returning corrupted content:
> interleaved columns and a header-less table read as hits, because the right
> page came back. Column association and reading order are answer-quality
> failures, and proving they are fixed needs an answer-level check this harness
> does not have. The two rows it does catch — the scanned page and the
> unrefused chart value — are genuine, and they are caught for the right
> reasons.

> **Corpus first.** None of the last three can be evaluated against today's
> `eval/corpus`, which is three clean-text documents. Extending it with a
> scanned page, a merged-cell table, a chart-only page and a two-column spread —
> plus questions whose answers live only there — is the first work item, not a
> follow-up. 0027's own lesson: nothing else is provable without it.

## Security & privacy

**The injection surface widens, and this is the real cost of the feature.**
Parser and vision output is model-generated text that lands in the index and is
later fed to the answering model. Text rendered _inside an image_ — which no
user skims and no text-layer check sees — now has a path into the prompt that it
did not have before. Two things bound it, and nothing else does: the
owner/knowledge-base filter that 0028 put in the same `WHERE` clause as
`owner_id` (which `read_figure` must reuse verbatim, not reimplement), and the
0029 invariant that refusal is a code path around the loop rather than an
instruction the model is asked to honour.

`read_figure` reads a stored PDF and returns pixels to an upstream model. It
must resolve the chunk through the same owner- and KB-scoped query as
`search_documents`; a tool taking a raw `chunkId` is one missing predicate away
from cross-tenant document disclosure.

Page images are sent to NVIDIA's endpoint. That is already true of document text
and is documented behaviour for the RAG feature, but images of documents are a
larger disclosure per call and should be stated plainly in
[`docs/rag.md`](../docs/rag.md).

## Alternatives considered

- **Transcribe figures at ingestion and index the numbers.** Measured and
  rejected: 15–30% error, confidently stated, after being told not to guess. A
  wrong number in the index is permanent and is confirmed by `verify.ts`.
- **Multi-vector / late-interaction page-image retrieval (ColPali-style).** The
  strongest published direction for visual documents, and the right answer if
  the storage layer suited it. It needs hundreds to a thousand vectors per page
  and MaxSim aggregation; in pgvector that means many rows per page and
  hand-rolled aggregation, which destroys the single-table single-query property
  that made hybrid retrieval clean in 0027. Revisit if the corpus becomes
  predominantly visual.
- **Single-vector multimodal embedding** (`nvidia/llama-nemotron-embed-vl-1b-v2`,
  on this account, 2048 dims — the same width as the existing column). Probed
  2026-09-10 and **it does not work as invoked**: a text query scored **−0.037**
  against the matching page image, while a nonsense query scored **+0.076**
  against an unrelated page; text→text on the same model scored 0.497. The model
  does decode pixels (0.944 across two renders of one page, 0.603 across
  different pages) and explicitly rejects images as queries — _"This model does
  not support image input as query"_ — so the intent is clearly text→image, but
  the two sub-spaces come out near-orthogonal. Filed the way 0027 filed the
  reranker: probed, unusable, revisit. Note also that equal dimensionality is
  not a shared vector space; adopting it would mean migrating the whole index,
  queries included.
- **Hand-rolled geometry heuristics from `extractTextItems`** (column
  clustering, font-size heading detection, table detection from x/y alignment).
  Free and offline, and it was the first plan. Rejected once the parse output
  was seen: it reimplements — worse — what one call already returns typed and
  boxed. The one piece kept is triage, and it is kept for cost, not quality.
- **A Python sidecar** (PyMuPDF + Tesseract). More capable, breaks the
  single-container story. Same judgement 0027 reached.
- **`llama-3.2-90b-vision-instruct`** for descriptions. Did not return inside 5
  minutes on this tier. Not viable.
- **Markdown for tables.** Cannot express merged cells; would discard structure
  the parser correctly recovered.

## Out of scope / future

- Rendering span highlights in the UI from `chunks.bbox`. This spec captures the
  boxes; drawing them is 0026's deferred item and can land separately.
- Structured extraction of high-value tables into relational storage, answered
  with SQL or a calculator tool instead of an LLM doing arithmetic over markup.
- Non-PDF formats.
- A worker queue, if per-page cracking makes ingestion long enough that
  `pages_processed` polling stops being adequate.
- Re-probing for a reranker, and for the multimodal embedder above.
- **Describing caption-less figures** (FR6's second half). A figure with a
  caption is findable for free and `read_figure` covers the rest; generating a
  description for the caption-less case is the remaining piece, and it is the
  one that spends ~40s per figure at ingestion.
- **Quantitative reading of unlabelled charts.** Out of reach of this model, and
  `redactUnlabelledNumbers` is the honest response rather than a workaround. A
  chart whose values are printed reads correctly today.
- **An answer-level assertion in `eval/run.ts`.** The harness scores retrieval
  only, so a chunk containing a flattened table or interleaved columns counts as
  a hit. Checking that an expected string appears in the drafted answer — with
  the model call that implies — is what would make the table and column gaps
  measurable, and it is a change to the harness's contract rather than to this
  pipeline.
- **Pages carrying a `/Rotate` attribute.** Landscape _page geometry_ is
  verified; a portrait page whose content is rotated 90° is a different case
  and is untested. It needs a decision about whether `renderPageAsImage`
  applies the rotation before the parser sees it.

## References

- All measurements taken against `https://integrate.api.nvidia.com/v1` on
  **2026-09-10** with the account's own key: `nemotron-parse` element output and
  token counts, the 11b/90b vision latency and error figures, the PNG/JPEG
  discrepancy, and the multimodal-embedding cosine table.
- Model availability re-probed 2026-09-10 — 80 models; `nemotron-parse`,
  `llama-3.2-11b/90b-vision-instruct`, `llama-nemotron-embed-vl-1b-v2` present;
  **no reranker**, confirming 0027.
- Builds on [`0025`](0025-rag-knowledge-base-and-chat.md) (extraction, chunking),
  [`0026`](0026-chat-first-ux-and-history.md) (deferred span citations),
  [`0027`](0027-agentic-rag-and-document-cracking.md) (Phase 2, previously
  Not started), [`0028`](0028-independent-knowledge-bases.md) (the scoping filter
  `read_figure` must reuse) and [`0029`](0029-agentic-retrieval-loop.md) (the
  loop, its budgets and its refusal invariant).
- Current behaviour documented in [`docs/rag.md`](../docs/rag.md).
