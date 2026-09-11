---
id: 0038
title: Store the search key, and show what the page contributed
status: Proposed
release: '—'
created: 2026-09-11
updated: 2026-09-11
---

# 0038 — Store the search key, and show what the page contributed

## Summary

A figure's caption is embedded and then thrown away. So is the section heading
above every chunk. Both shape what retrieval matches, neither is stored, and
neither can be shown to the user who wants to know why a passage was returned.

This spec persists them, puts them in the lexical index alongside the dense one,
draws them on the page, and adds a raw view of the stored record so the answer
to "what does the index actually hold for this chunk" is on screen rather than
inferred.

## Problem / motivation

### A search key that exists only inside a vector

[`0031`](0031-tables-figures-and-complex-layouts.md) established that a figure
is found by its caption, or — for a caption-less figure — by a one-sentence
label a vision model writes at ingestion. `describeFigures` folds either into
`element.caption`, `buildEmbeddingText` prepends it before embedding, and the
`chunks` table has no column for it.

Measured on the local corpus, 2026-09-11. The query
_"unplanned downtime by quarter across all sites"_ uses words that appear in the
page-4 caption of `rag-cracking-test` and in **no chunk's stored content**:

| page | kind   | dense similarity | lexical match |
| ---- | ------ | ---------------- | ------------- |
| 4    | figure | **0.650**        | no            |
| 6    | table  | 0.216            | no            |
| 1    | text   | 0.183            | no            |

The caption is doing all of the work, and it is doing it in exactly one place.
Consequences, all of them silent:

- **No lexical path.** `chunks.content_tsv` is generated from `chunks.content`
  alone, so half of hybrid retrieval cannot see a caption or a heading. A
  keyword-shaped question — an exact figure number, a term of art from a
  caption — has only the vector to find it with.
- **Nothing to show.** A citation cannot display the sentence that matched, and
  neither can [`0037`](0037-inspect-what-was-indexed.md)'s inspector. For a
  caption-less figure this means a ~40-second vision call produces a sentence no
  human will ever read.
- **Nothing to check.** A user cannot tell a bad label from a good one, which
  makes the one non-deterministic step in ingestion the one step with no
  oversight.

The same is true of headings, for the same reason: `normalizePage` consumes
`Title` and `Section-header` elements into `NormalizedElement.heading`, that
reaches the embedded text, and only `chunks.heading` survives — with no box, so
nothing on the page marks it.

### The page shows less than the index holds

0037's inspector draws a box per chunk. A reader looking at page 1 of
`rag-cracking-test` sees "Plant Asset Report" and "1. Purpose" unmarked and
concludes they were not indexed; they were. On page 4, "Figure 6.1: Unplanned
downtime by quarter…" is unmarked and is the single most load-bearing string on
the page.

Marking them is not decoration. The boxes are the difference between "this is
what was indexed" and "this is what was indexed, minus the parts that are hard
to draw".

### Derived text needs a way to be audited

`buildEmbeddingText` composes `title — heading — caption` + content. Nothing
shows that composition, so the one string that determines dense retrieval is
invisible. A raw view is the cheapest possible fix and it makes every question
in this spec answerable by looking.

## Goals

- A chunk's caption and heading are stored, not just embedded.
- Both reach the lexical half of retrieval.
- Both are drawn on the page image, distinguishably from the chunk itself.
- A reader can see the exact stored record for a chunk, and the text that was
  composed for embedding.

## Non-goals

- Changing chunking, routing, or the retrieval algorithm. This spec changes
  **what text is indexed**, not how a match is scored or fused.
- Re-describing figures that already have a label. No new vision calls.
- Backfilling existing rows. The data was never stored, so there is nothing to
  backfill from — a document shows the new detail after it is re-ingested, and
  says nothing misleading before.
- Editing a caption by hand. Read-only, as 0037 is.

## Requirements

### Functional

- **FR1** — `chunks.caption` stores the bound caption or the generated figure
  label, exactly as it was used for embedding.
- **FR2** — `chunks.heading_bbox` and `chunks.caption_bbox` store where the
  heading and caption sit on the page, when the cracked path produced them.
- **FR3** — `chunks.content_tsv` is generated from heading, caption and content
  together, so a keyword query can match a caption or a section title.
- **FR4** — The inspector draws heading and caption regions on the page,
  visually distinct from the chunk's own region and from each other, with a
  legend naming each.
- **FR5** — A chunk's stored caption is shown in its detail panel, labelled as
  what makes the chunk findable rather than as the document's narrative.
- **FR6** — A raw view shows the stored record for a chunk — every column this
  view reads — and the text composed for embedding, labelled as recomposed
  rather than stored.
- **FR7** — A document ingested before this spec renders exactly as it does
  today: no caption, no heading box, no invented ones.

### Non-functional

- **NFR1** — No new inference calls. Captions and labels are already produced;
  this only stops discarding them.
- **NFR2** — The raw view is owner-scoped like everything else in 0037 and adds
  no new route.
- **NFR3** — Regenerating `content_tsv` must not change what an existing row
  matches on beyond adding the new text. Content stays in the vector.
- **NFR4** — The lexical change alters retrieval and must be measured with
  `pnpm rag:eval` before the release that ships it — refusal rate above all,
  since a wider `tsvector` means more lexical hits and the refusal gate sits
  downstream of scoring.

## Design / approach

### Plumbing, not new machinery

`bindCaptions` already finds the caption element; it currently returns only its
text. It returns the box as well. `normalizePage` already tracks the current
heading; it tracks the heading's box alongside. `chunkElements` already copies
`element.caption` onto the chunk; `ingest.ts` writes two more columns. Nothing
new is computed anywhere.

### The lexical column

```sql
to_tsvector('english',
  coalesce(heading, '') || ' ' || coalesce(caption, '') || ' ' || content)
```

A generated column cannot be altered in place, so the migration drops and
re-adds it, which re-derives every row from columns that already exist. Old
rows gain nothing and lose nothing: their `heading` is populated, their
`caption` is null.

### Drawing three kinds of region

The page carries regions of three different weights and they must not look
alike:

| region  | meaning                                     | drawn as            |
| ------- | ------------------------------------------- | ------------------- |
| chunk   | this text is in the index as a passage      | solid amber ring    |
| heading | indexed as context for the chunks below     | thin blue outline   |
| caption | the search key that makes a figure findable | dashed teal outline |

Heading and caption boxes are page-level and deduplicated: one heading owns
several chunks, and drawing it once per chunk stacks identical rectangles into
something that reads as emphasis.

### The raw view

A disclosure inside the chunk panel, showing the stored columns verbatim plus
`buildEmbeddingText`'s output. The composed string is **recomputed for display**
and must say so — the document's title can change after ingestion, at which
point the recomposition and the vector disagree, and pretending otherwise would
make this view the thing it exists to prevent.

## Acceptance criteria

- [x] A re-ingested figure chunk has its caption in `chunks.caption`
- [x] A caption-less figure stores the generated label in the same column
- [x] A keyword query matching only a caption returns the figure by lexical
      match, where before it matched nothing
- [x] Heading and caption regions are drawn on the page, distinct from the chunk
      region and from each other, with a legend
- [x] A chunk's caption is shown in its detail panel, labelled
- [x] The raw view shows the stored record and the composed embedding text,
      with the composed text marked as recomputed
- [x] A document ingested before this spec renders as it did, with no invented
      caption or heading box
- [ ] `pnpm rag:eval` is run and the refusal rate is unchanged

## Security & privacy

No new disclosure. A caption is document text or a label derived from document
pixels, both of which already reach the index and the answering model. The raw
view shows columns the same owner-scoped query already returns.

Stored caption text is untrusted document content and a generated label is
model output: both are displayed, never interpreted, exactly as chunk content
is.

## Alternatives considered

- **Store the caption only for figures.** Smaller, and it leaves a table's
  caption — "Table 4.1 — Rates by trade and shift" — outside the lexical index
  for no principled reason.
- **Prepend the caption to `content`.** One column, no migration of the
  generated index. It also makes the caption indistinguishable from the
  document's own words at citation time, which is the exact confusion 0031 spent
  a spec avoiding.
- **A separate `chunk_annotations` table.** Correct if annotations were to
  multiply. There are two, both one-to-one with a chunk, and a join to draw a
  rectangle is not worth it.
- **Backfill by re-running the parser.** Costs the whole corpus in vision and
  parse calls to recover text that a re-ingest produces anyway.

## Out of scope / future

- Showing the stored caption in the citation panel, which has its own wording
  problem: it currently tells a reader a figure citation is "not the document's
  own words" when the stored content is precisely the document's printed words.
- Weighting the lexical vector (`setweight`) so a caption match outranks a body
  match.
- Re-ingesting a document from the UI without flipping its status by hand.
- **Teaching the text-layer path what page furniture is.** `detectHeading`
  takes the page's first line, which on a document with a running header is the
  header — so a text-layer chunk's `heading` is often
  "NORTHBRIDGE UTILITIES · INTERNAL · ASSET REPORT FY26". That was already
  prepended to the embedded text; putting headings in `content_tsv` now puts it
  in the lexical index too, on every text-layer chunk of the document. Low IDF
  makes it mostly harmless and it is not nothing, and the fix belongs with
  `detectHeading` rather than here. The cracked path is unaffected: it drops
  `Page-header` and `Page-footer` as furniture before headings attach.

## References

- [`0031`](0031-tables-figures-and-complex-layouts.md) — captions, the
  search-key/evidence split, and `describeFigures`.
- [`0037`](0037-inspect-what-was-indexed.md) — the inspector this extends, and
  the rule that it must never make the index look better than it is.
- `src/lib/rag/chunk.ts` — `buildEmbeddingText`, the composition this exposes.
