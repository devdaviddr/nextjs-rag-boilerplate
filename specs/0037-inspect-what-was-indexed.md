---
id: 0037
title: Let a user inspect what was actually indexed
status: Proposed
release: '—'
created: 2026-09-11
updated: 2026-09-11
---

# 0037 — Let a user inspect what was actually indexed

## Summary

A document's row says `Ready · 8 pages · 21 chunks` and stops. Everything else
the system knows about that document — which pages it parsed, which it read the
cheap way, which it gave up on and why, what text it actually stored, and where
on the page each chunk came from — is recorded and shown to nobody.

This spec surfaces it: a per-document view that renders each page and overlays
what was indexed from it, alongside the per-page routing record already stored in
`documents.extraction`.

The point is not a debugging panel. It is that **the system currently detects its
own partial failures and keeps them to itself**, and a RAG product whose selling
point is grounded answers cannot also be the only party who knows what is
missing.

## Problem / motivation

### "Ready" is a lie of omission

[`0031`](0031-tables-figures-and-complex-layouts.md) exists because of a silent
failure: a 40-page report with a scanned appendix passed the image-only check,
ingested, reported success — and the appendix was not in the index. Nobody was
told.

[`0034`](0034-resumable-ingestion.md) then added `documents.extraction`, which
records per page what route it took and what happened:

```json
{
  "pages": [
    { "page": 7, "route": "no-text", "outcome": "parsed" },
    {
      "page": 8,
      "route": "no-text",
      "outcome": "failed",
      "reason": "Parser found no elements. This page is not indexed."
    }
  ],
  "parseCalls": 6,
  "describeCalls": 1,
  "budgetExhausted": false
}
```

Every field needed to say _"page 8 of this document is not searchable"_ is in the
database. The UI renders `Ready`.

The same is true of `budgetExhausted`. A document that hit
`RAG_CRACK_MAX_PAGES` is deliberately, correctly, **partially** indexed — 0031
FR11 chose degrading over failing — and the badge for that outcome is identical
to the badge for a perfect one.

### A refusal is only believable if you can check it

When the system says _"I couldn't find anything about that in your documents"_,
the user has no way to tell that from _"that page never got indexed"_. Refusal
accuracy is this project's strongest guarantee and its most load-bearing claim;
it is also the claim a user is least able to verify. Inspection is what makes a
refusal checkable rather than something to be taken on trust.

### The indexed text is not always the document's text

Since 0031 a `figure` chunk's stored content is a **search key** — a caption, or
a generated one-sentence label — written to make the figure findable, explicitly
not the document's own words. An `ocr` chunk is the document's words _recovered
from an image of them_, which is a different confidence claim from text read
off a text layer.

Those distinctions are recorded in `chunks.kind` and are currently invisible
outside the codebase.

### Almost all of it already exists

| Needed                     | Already there                                                           |
| -------------------------- | ----------------------------------------------------------------------- |
| Per-page route and outcome | `documents.extraction` ([`0034`](0034-resumable-ingestion.md))          |
| Page images                | `/api/documents/[id]/page?n=N` ([`0035`](0035-span-level-citations.md)) |
| Region overlay on a page   | `source-viewer.tsx`, `toCitationBoxes`                                  |
| What each chunk is         | `chunks.kind` ([`0031`](0031-tables-figures-and-complex-layouts.md))    |
| Where each chunk came from | `chunks.boxes` / `chunks.bbox`                                          |
| Progress during ingestion  | `documents.pages_processed`                                             |

This is mostly assembly. The new work is one query, one view, and the honesty
decisions below.

## Goals

- A user can see, per page, whether it was indexed and how.
- A user can see what text was stored for a page, and where on the page it came
  from.
- A partially-indexed document is **visibly** partial, in the list, not only in
  a detail view someone has to think to open.
- A `figure` chunk is never presented as the document's own words.

## Non-goals

- Editing, deleting or re-ordering chunks. Read-only.
- Re-ingesting a single page. Worth having; needs the ingestion path to accept a
  page range, which is [`0034`](0034-resumable-ingestion.md)'s territory.
- Changing chunking, routing or retrieval. This spec adds no behaviour to the
  pipeline it observes.
- A diagnostics console. Retrieval scores, embeddings and planner traces are a
  different feature for a different reader.

## Requirements

### Functional

- **FR1** — A document detail view, reachable from the documents list, showing
  every page of the document.
- **FR2** — Each page renders as an image with the regions of its indexed chunks
  overlaid, reusing the mechanism [`0035`](0035-span-level-citations.md) built
  for citations.
- **FR3** — Each page shows its recorded `route` and `outcome`, in plain
  language rather than the enum — "read from its text layer", "read page by page
  because it has tables", "not indexed: the parser found nothing".
- **FR4** — Selecting a chunk shows the **stored text** — what retrieval will
  actually match against — its `kind`, and its page.
- **FR5** — A `figure` chunk's text is labelled as a search key, not a
  quotation. An `ocr` chunk is labelled as recovered from an image.
- **FR6** — A page that produced **no chunks** is called out as not searchable,
  with the recorded reason where there is one.
- **FR7** — The documents **list** distinguishes a fully-indexed document from a
  partially-indexed one. `budgetExhausted`, any page whose outcome is `failed`,
  or any page with no chunks makes the document partial.
- **FR8** — A document ingested before `documents.extraction` existed, or with
  cracking off, shows what is known and says the rest is unrecorded — never a
  fabricated per-page story.

### Non-functional

- **NFR1** — Owner-scoped in the `WHERE` clause, with the same non-signal 404 as
  `/api/documents/[id]/source`. This view exposes a document's full indexed text.
- **NFR2** — A 200-page document must not render 200 page images. Pages load as
  they are looked at.
- **NFR3** — Read-only. No route added here may mutate a document, a chunk or an
  extraction record.
- **NFR4** — Nothing on the ingestion or retrieval hot path changes. This
  feature reads what already exists.

## Design / approach

### Where it lives

`/documents/[kbId]/[documentId]`, from a click on the row that today only offers
a delete button. A Server Component fetches the document, its
`extraction`, and its chunks grouped by page; the page images stream from the
existing route.

### The join that matters

`documents.extraction.pages` is the **authoritative list of pages** — including
pages that produced nothing. Driving the view from `chunks` instead would make
exactly the pages this spec exists to reveal invisible, because a page with no
chunks contributes no rows. Left join chunks onto the extraction record, never
the reverse.

For FR8, a document with no `extraction` falls back to `pageCount` and whatever
chunks exist, and says the routing detail was not recorded.

### Saying it in plain language (FR3)

The stored vocabulary is internal. A mapping table, not a raw enum:

| stored                      | shown                                                  |
| --------------------------- | ------------------------------------------------------ |
| `clean-text` / `text-layer` | Read from the page's own text                          |
| `structured` / `parsed`     | Read page by page — it has columns or tables           |
| `image-heavy` / `parsed`    | Read page by page — it has figures                     |
| `no-text` / `parsed`        | Scanned page, read with OCR                            |
| any / `budget-skipped`      | Read the quick way — this document hit its page budget |
| any / `failed`              | **Not indexed** — plus the recorded reason             |

### FR7 is the requirement that actually matters

A detail view only helps a user who already suspects something is wrong. The
list is what everyone reads. If `Ready` continues to mean both "fully indexed"
and "indexed except pages 7 and 8", this spec has built a page nobody opens.

So the badge gains a partial state, and it must be derived from the recorded
outcomes rather than from a new column — the data is already there and a second
source of truth would drift.

### What a reviewer must not get wrong

**This view must never make the index look better than it is.** Every temptation
here runs one way: hiding an empty page because it looks like a rendering bug,
showing a figure's search key as if it were the document's caption, treating an
absent `extraction` record as "fine". A user opens this to find out what is
missing, and an inspection tool that rounds up is worse than none — it converts
a silent gap into a gap the user has actively been reassured about.

## Acceptance criteria

- [ ] A document detail view lists every page from `documents.extraction`,
      including pages that produced no chunks
- [ ] Each page renders with its indexed regions overlaid
- [ ] Each page states its route and outcome in plain language, not the enum
- [ ] Selecting a chunk shows the stored text, its kind and its page
- [ ] A `figure` chunk is labelled as a search key and an `ocr` chunk as
      recovered from an image — neither reads as a quotation
- [ ] A page with no chunks is called out as not searchable, with its reason
- [ ] The documents **list** shows a partially-indexed document differently from
      a fully-indexed one, derived from the recorded outcomes
- [ ] A document with no `extraction` record renders without inventing one
- [ ] A document belonging to another user returns the same 404 as one that does
      not exist
- [ ] A 200-page document does not fetch 200 page images to render the view
- [ ] `docs/rag.md` documents the view and what "partially indexed" means

## Security & privacy

This view renders a document's full indexed text and its page images in one
place, which makes it a more attractive target than any single citation. Owner
scoping belongs in the `WHERE` clause of every query it makes, exactly as
`retrieveDocumentChunks` and `resolveFigure` do — and for the same reason those
carry warnings: they resolve a caller-supplied id and return content.

No new disclosure to third parties. Page images already stream from
[`0035`](0035-span-level-citations.md)'s route under the same hardening, and no
chunk text leaves the deployment.

Stored chunk text is untrusted document content. It is displayed, never
interpreted — the same posture the answering path takes with retrieved
passages.

## Alternatives considered

- **Surface it only when something failed.** Cheaper, and it makes the tool
  unavailable exactly when a user is trying to establish that nothing failed.
  Verifying a refusal is half the value.
- **A raw JSON dump of `extraction`.** A morning's work and useless to the
  person who needs it. The routing vocabulary is internal and its meaning is the
  thing being communicated.
- **Show chunks without page images.** Much simpler. It also cannot answer "was
  this table indexed?", which needs the page and the region together — and the
  rendering machinery already exists.
- **Put it in the chat citation panel instead.** That panel answers "where did
  this claim come from". This answers "what does the system know about this
  document". Different questions, and conflating them makes the panel worse at
  the first.

## Out of scope / future

- Re-ingesting a single page or a page range.
- Showing retrieval scores or embeddings.
- Exporting the extracted text.
- Comparing two ingestions of the same document — which would become useful the
  moment [`0033`](0033-retrieval-fundamentals.md)'s chunking changes land.

## References

- [`0031`](0031-tables-figures-and-complex-layouts.md) — `chunks.kind`, the
  search-key/evidence split, and the silent-appendix failure that motivates this.
- [`0034`](0034-resumable-ingestion.md) — `documents.extraction`, the per-page
  record this view reads.
- [`0035`](0035-span-level-citations.md) — the page-render route and the region
  overlay this view reuses.
- `src/app/api/documents/[id]/source/route.ts` — the ownership and hardening
  posture NFR1 refers to.
