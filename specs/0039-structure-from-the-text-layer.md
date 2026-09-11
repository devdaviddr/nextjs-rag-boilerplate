---
id: 0039
title: Find a document's structure in its text layer
status: Proposed
release: '—'
created: 2026-09-11
updated: 2026-09-11
---

# 0039 — Find a document's structure in its text layer

## Summary

A page that goes to the layout parser comes back as typed elements and gets
everything built on them: furniture dropped, captions bound, headings attached
with their boxes, one chunk per element. A page that triage sends to the text
layer gets none of it — one page-sized chunk, the running header promoted to a
heading, the footer indexed as prose.

Both are pages of the same document, and the difference is invisible to the
reader except as a difference in what the page appears to contain.

This spec closes the gap with no API call, from two signals the PDF already
reports and this pipeline was discarding: **point size** and **end-of-line**.

## Problem / motivation

### The same document, read two ways

[`0037`](0037-inspect-what-was-indexed.md) made this visible. On
`rag-cracking-test`, page 3 went to the parser and page 1 did not:

|               | page 1 (`clean-text`)                                  | page 3 (`structured`)             |
| ------------- | ------------------------------------------------------ | --------------------------------- |
| chunks        | 1, the whole page                                      | 3, one per element                |
| regions drawn | one box round everything                               | one per table, caption, paragraph |
| heading       | `NORTHBRIDGE UTILITIES · INTERNAL · ASSET REPORT FY26` | `4. Contractor rates`             |
| footer        | indexed as content                                     | dropped as furniture              |

The heading on page 1 is the running header, because `detectHeading` takes the
page's first line. Since [`0038`](0038-store-the-search-key.md) put headings in
`content_tsv`, that boilerplate is now in the lexical index on every text-layer
chunk of the document.

### The signals were already there

Measured on `rag-cracking-test` with `unpdf`, 2026-09-11:

| point size | line                                                   |
| ---------- | ------------------------------------------------------ |
| 7.5        | `NORTHBRIDGE UTILITIES · INTERNAL · ASSET REPORT FY26` |
| **17.0**   | `Plant Asset Report`                                   |
| **12.5**   | `1. Purpose`                                           |
| 10.5       | body text                                              |
| 8.5        | `Table 8.1 — Cutover waves…`                           |
| 7.5        | `Confidential — Page 6 of 7 — Rev 4`                   |

`toPositionedItems` received every one of those sizes and kept only `str` and
`box`. The structure was being thrown away one function below where it was
needed. `hasEOL` was discarded in the same line, which is why lines had to be
inferred at all.

### What this is not

It is not a layout model and cannot find a table or a figure — neither leaves
any text-layer signature, and guessing would draw a `Table` around a paragraph.
That matters less than it sounds: triage routes a page with a table or a figure
to the parser before this code sees it. What reaches the text-layer path is
prose, which is what point size describes well.

## Goals

- A text-layer page yields the same kind of typed elements a parsed page does.
- The running header and footer stop being indexed as content.
- A heading is the document's actual heading, with its box, on both paths.
- No new API call, and no behaviour change for a PDF that reports no sizes.

## Non-goals

- Detecting tables or figures without the parser.
- Changing triage. Which pages go to the parser is [`0031`](0031-tables-figures-and-complex-layouts.md)'s decision and is unchanged.
- Parent–child chunking. Per-element chunks are a consequence here, not the
  subject; the retrieval-side question is [`0033`](0033-retrieval-fundamentals.md)'s.
- OCR pages. A page with no text layer has no sizes to read.

## Requirements

### Functional

- **FR1** — `PositionedItem` carries the point size and end-of-line flag the
  PDF reports, when it reports them.
- **FR2** — A line repeated at the same end of the page across pages, set
  smaller than body text, is classified as a running header or footer and
  dropped before indexing.
- **FR3** — A short line set above body size is a heading; well above, a title.
- **FR4** — A line naming its own figure or table (`Table 4.1`, `Figure 6.1`) is
  a caption, and binds to a neighbouring element through the existing
  `bindCaptions`.
- **FR5** — Consecutive body lines become one paragraph element; a blank line or
  a column break ends it.
- **FR6** — The output is `ParsedElement[]`, so `normalizePage` and
  `chunkElements` serve both paths and nothing downstream learns a second shape.
- **FR7** — A PDF reporting no point sizes, or a page with no positioned items,
  falls back to `chunkPages` and behaves exactly as before.
- **FR8** — Detection is not part of cracking: it applies with
  `RAG_CRACK_ENABLED` off.

### Non-functional

- **NFR1** — No inference call, no network, no cost per page.
- **NFR2** — Pure and unit-testable, like `normalize.ts` — the thresholds are
  the whole design and must be testable against recorded geometry.
- **NFR3** — Every rule fails towards `Text`. Wrongly classifying a paragraph as
  furniture **deletes it from the index**; failing to classify one costs
  nothing but the structure it would have had.
- **NFR4** — Chunk boundaries change for every text-layer document, so
  `pnpm rag:eval` must be run and reported before the release that ships it.

## Design / approach

### Thresholds, and why each is where it is

| rule               | value                    | why                                                                                     |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------------- |
| heading            | ≥ 1.12 × body            | the measured step is 1.19 (12.5 / 10.5); real documents step by a point                 |
| title              | ≥ 1.4 × body             | the measured title is 1.62                                                              |
| heading length     | ≤ 120 chars              | a long line set large is a pull-quote, not a label                                      |
| furniture position | first or last 2 lines    | **by rank, not margin** — see below                                                     |
| furniture repeats  | ≥ 2 pages                | repetition is the entire signal; one page cannot tell its footer from its last sentence |
| furniture size     | **strictly** < body      | see below                                                                               |
| paragraph break    | gap > 0.6 × glyph height | measured: 0.14 within a paragraph, 1.3 across one                                       |

**Position by rank.** The measured footer sits **71% down** a page whose
content stops early. An absolute bottom-margin band misses it entirely; "the
last line on the page" finds it on every page of every document.

**Strictly smaller than body.** On a short page the last line of real prose is
positionally an edge line. If a document repeats a sentence — a signature line,
a standing instruction — a `<=` test would delete it from the index. A running
head set at body size is therefore missed and stays indexed, which is exactly
today's behaviour. The costs are not symmetric, so the test is not either.

**Page numbers are masked** (`\d+` → `#`) before comparing lines, or
`Page 1 of 7` and `Page 2 of 7` are two different strings and a paginated
footer repeats zero times.

**Columns.** A column break is a large NEGATIVE vertical gap, which a test
looking only for a large positive one reads as "no gap". Measured on page 2,
that merged the foot of the left column into the head of the right: two
paragraphs about two different buildings, indexed as one passage. The paragraph
test is bounded on both sides.

### Where it runs

`documentLayout` once per document — body size and furniture are document-level
facts, and deriving them per page would make page 1's answer differ from page
5's. Then per page: lines → typed elements → `normalizePage` → `chunkElements`,
the same two functions the cracked path calls.

## Acceptance criteria

- [x] A text-layer page produces one element per paragraph, heading and caption
- [x] The running header and footer are absent from the indexed content
- [x] A text-layer chunk's `heading` is the section heading, with a box
- [x] Two columns do not merge into one passage
- [x] A PDF reporting no point sizes produces exactly what it did before
- [x] Detection runs with `RAG_CRACK_ENABLED` off
- [x] `pnpm rag:eval` is run and its numbers reported against the reference

### Measured, 2026-09-11

Identical to the run of 2026-09-10, before this spec and
[`0038`](0038-store-the-search-key.md):

|                          | 2026-09-10 | after 0038 + 0039 |
| ------------------------ | ---------- | ----------------- |
| single-hop hit@1 (n=17)  | 0.882      | 0.882             |
| single-hop MRR           | 0.912      | 0.912             |
| refusal accuracy         | 1.000      | 1.000             |
| cross-KB leakage         | 0          | 0                 |
| layout suite hit@1 (n=8) | 1.000      | 1.000             |

Chunk boundaries moved for every text-layer document in the corpus and the
numbers did not move at all. That is the result: **no regression, and no
measured gain either**. The gains this spec claims — furniture out of the
index, a heading that is the real heading, consistent regions on the page — are
not things these questions ask about. Worth saying plainly rather than
implying the eval endorsed them.

## Security & privacy

None. Nothing leaves the process; this reads geometry already extracted from a
PDF the deployment already parses.

## Alternatives considered

- **Send every page to the parser.** Consistent immediately and needs no new
  logic. It also costs one API call per page against a rate-limited free tier,
  makes ingesting plain prose slow and network-dependent, and defeats the
  `RAG_CRACK_MAX_PAGES` budget that exists to prevent exactly that.
- **Detect furniture only, leave chunking alone.** Removes the boilerplate and
  leaves page 1 a single box with no headings — the visible inconsistency that
  prompted this survives untouched.
- **Bold detection via font name.** `unpdf` reports `fontFamily: "sans-serif"`
  for every item in the measured document, so weight is not available. Size is.
- **A layout model on the text layer.** Real, and far more than this needs. The
  parser already exists for pages that need a model; this is for pages that
  do not.

## Out of scope / future

- Lists, block quotes and footnotes as their own types.
- Using the detected heading hierarchy for parent–child chunking
  ([`0033`](0033-retrieval-fundamentals.md)).
- Detecting a table by column alignment in the text layer.

## References

- [`0031`](0031-tables-figures-and-complex-layouts.md) — triage, and the
  `ParsedElement` shape this produces.
- [`0037`](0037-inspect-what-was-indexed.md) — the view that made the
  inconsistency visible.
- [`0038`](0038-store-the-search-key.md) — headings in the lexical index, which
  is what made the wrong heading matter.
