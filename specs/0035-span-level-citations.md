---
id: 0035
title: Highlight the cited span, not just the page
status: Proposed
release: '—'
created: 2026-09-10
updated: 2026-09-10
---

# 0035 — Highlight the cited span, not just the page

## Summary

A citation opens the source PDF at the right page and stops there. The reader
then has to find the sentence themselves — on a dense page, that is most of the
work the citation was supposed to save.

[`0026`](0026-chat-first-ux-and-history.md) deferred this and named its blocker
precisely: _"Capturing per-chunk boxes during extraction would enable a real
highlight, but it changes the ingestion schema and requires re-ingesting every
existing document — its own spec, not a footnote to this one."_
[`0031`](0031-tables-figures-and-complex-layouts.md) did the schema half.
`chunks.bbox` exists and is populated. This spec is the other half.

## Problem / motivation

Two things stand between the stored box and a highlight on screen.

**Half the chunks have no box.** `chunks.bbox` is written by `chunkElements`,
the cracked path. `chunkPages`, the text-layer path, does not set it — measured
on the eval corpus: 16 `text` chunks, **5 with a box**. So today a highlight
would work on cracked documents and silently do nothing on the rest, which is
worse than a uniform page-level citation: the reader learns to expect a
highlight and then cannot tell "no box" from "no match".

This is fixable rather than fundamental. `unpdf`'s `extractTextItems` returns
per-item `x`, `y`, `width`, `height` — `signals.ts` already calls it for column
detection. The positions are in hand and thrown away.

**The viewer cannot draw.** The citation panel frames
`/api/documents/[id]/source` and lets the browser's own PDF viewer render it.
That route's comment records the consequence:

> Eliminating even that means either serving documents from a separate origin,
> or rendering with pdf.js — which is the upgrade path recorded in spec 0026.

A native viewer in an iframe takes `#page=N` and nothing else. There is no way
to draw a rectangle on it. Highlighting requires rendering the page ourselves.

That is a larger change than it sounds, and it has a security dimension the
route already reasoned about: the PDF is currently rendered by the browser's own
viewer in its own process, with no access to this page's DOM or cookies.
Rendering with pdf.js **moves untrusted document content into our origin**. It
removes one residual risk (the viewer executing PDF JavaScript) and introduces a
different one.

## Goals

- A citation highlights the passage it came from, not just the page.
- Highlighting works on **every** document, not only cracked ones.
- The change to how PDFs are rendered is a deliberate, reviewed security
  decision rather than a side effect of wanting a highlight.

## Non-goals

- Word-level or character-level highlighting. Chunk-level is the resolution the
  data supports and is what a reader needs.
- Highlighting inside figures or tables beyond their bounding box.
- Changing what is retrieved or cited. This is presentation of an existing
  citation.

## Requirements

### Functional

- **FR1** — The text-layer path records a bounding box per chunk, derived from
  `extractTextItems`, so `bbox` coverage is not conditional on cracking.
- **FR2** — Boxes from both paths use one coordinate convention — normalised
  0–1, origin top-left — so a consumer never needs to know which path produced
  a chunk.
- **FR3** — Opening a citation scrolls to the page **and** visibly marks the
  cited region.
- **FR4** — A citation whose chunk has no box (a document ingested before this
  ships) falls back to today's page-level behaviour, silently and correctly.
- **FR5** — A `figure` chunk's highlight covers the figure. Its citation must
  keep saying it is a description rather than the document's words
  ([`0031`](0031-tables-figures-and-complex-layouts.md) FR10) — a highlight
  makes it look more like a quotation, so the labelling matters more here, not
  less.
- **FR6** — A chunk spanning several elements highlights all of them, not their
  bounding union, which on a two-column page would cover the gutter and the
  wrong column.

### Non-functional

- **NFR1** — Rendering must not weaken the isolation the source route
  established. Whatever replaces the native viewer is reviewed against that
  route's threat model, and the route's hardening headers stay.
- **NFR2** — No re-ingest required for correctness. FR4 guarantees old documents
  keep working; a re-ingest only improves them.
- **NFR3** — The viewer must not become the reason a page is slow. Rendering is
  on the citation panel's path, not the answer's.

## Design / approach

### FR1 — boxes on the text-layer path

`chunkPages` works on a page string and has no positions. The change is to give
it the positioned items `signals.ts` already fetches, and to record, for each
chunk, the union of the boxes of the items it consumed.

The subtlety is that `chunkPages` splits text by paragraph and sentence, not by
item, so mapping a chunk's characters back to items needs the item sequence to
be walked alongside the text. That is bookkeeping, and it is the whole of FR1's
difficulty.

FR6 falls out of the same work: keep the **list** of item boxes per chunk rather
than one union. A chunk that spans two columns then highlights two rectangles,
which is what the reader needs to see.

### FR2 — one convention

`nemotron-parse` returns normalised 0–1 with origin top-left. **PDF's own
coordinate system is bottom-left**, which is what `extractTextItems` reports.
Converting at ingestion, once, is right: a consumer that must ask which path
produced a chunk before it can read its box has been handed the problem rather
than a solution.

### FR3 — rendering

Two routes, and this is the decision the spec exists to force:

1. **Render with pdf.js in the citation panel.** Full control, highlights are
   straightforward, and it is the path 0026 and the source route both name. It
   moves untrusted PDF content into our origin — see NFR1.
2. **Serve the document from a separate origin** and keep a native viewer.
   Preserves isolation, and gives no way to draw the highlight, which defeats
   the spec.

So (1), with the security work done explicitly rather than assumed away. The
existing route keeps serving bytes; what changes is who renders them.

### What a reviewer must not get wrong

**A highlight is a stronger claim than a page number.** Pointing at a page says
"the answer is around here". Drawing a box says "this text, exactly". If the
box is wrong — off by an element, or the union of two columns — the citation is
now confidently wrong in a way the page-level version could not be, and the
whole value of citations in this system is that they can be trusted. FR4 and FR6
exist for that reason: no box is strictly better than a wrong box.

## Acceptance criteria

- [ ] Every chunk produced by the text-layer path carries a box —
      `tests/unit/rag-chunk.test.ts`
- [ ] Boxes from both paths are normalised 0–1 top-left, verified against the
      same page ingested each way — `tests/unit/rag-chunk.test.ts`
- [ ] A chunk spanning two columns records two boxes, not one union covering the
      gutter — `tests/unit/rag-chunk.test.ts`
- [ ] Opening a citation marks the cited region on the page
- [ ] A chunk with `bbox = null` opens at the page with no highlight and no
      error — `tests/e2e/`
- [ ] A `figure` citation is highlighted and still labelled as a description,
      not a quotation
- [ ] The source route's hardening headers are unchanged, and the new rendering
      path is reviewed against its threat model with the outcome recorded here
- [ ] `docs/rag.md`'s "Citations resolve to a page, not a sentence" gap is
      removed

## Security & privacy

The substantive change is **where an untrusted PDF is rendered**. Today the
browser's own viewer renders it in its own process, isolated from this page's
DOM and cookies; the source route's comment documents that as a residual risk
accepted deliberately, with pdf.js named as the upgrade path.

Rendering with pdf.js trades that: PDF JavaScript is no longer executed by a
viewer at all, and the document's content is now processed by our code in our
origin. That is a different risk, not obviously a smaller one, and the review in
the acceptance criteria is the point at which it gets decided rather than
inherited.

The route's own hardening — `X-Content-Type-Options: nosniff`, a pinned content
type, `Cache-Control: private, no-store` — stays regardless.

## Alternatives considered

- **Highlight only cracked documents.** Cheapest, and it produces a feature that
  works sometimes with no way for the reader to know when. Rejected in FR1.
- **Re-ingest everything to get boxes.** Would make coverage uniform and forces
  a migration on every deployment for a presentational gain. FR4 achieves
  uniform _behaviour_ without it.
- **Store character offsets instead of boxes.** Smaller, and it requires the
  viewer to map offsets to positions — the same problem, moved to the client.
- **Scroll to the text and let the browser's find highlight it.** No API for
  this in a framed native viewer, and it would fail on OCR text that does not
  match the rendered glyphs.

## Out of scope / future

- Word-level highlighting.
- Highlighting the specific sentence within a chunk that verification judged
  supported — that is `verify.ts` data and a natural follow-on.
- Copy-to-clipboard or annotation in the viewer.

## References

- [`0026`](0026-chat-first-ux-and-history.md) — deferred this and named the
  blocker; also names pdf.js as the rendering upgrade path.
- [`0031`](0031-tables-figures-and-complex-layouts.md) — added `chunks.bbox` and
  populated it for cracked pages.
- `src/app/api/documents/[id]/source/route.ts` — the threat model NFR1 refers
  to, including why `Content-Security-Policy: sandbox` was tried and removed.
- `src/lib/rag/signals.ts` — already calls `extractTextItems`; the positions FR1
  needs are being fetched and discarded.
