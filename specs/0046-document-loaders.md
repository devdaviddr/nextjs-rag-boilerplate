---
id: 0046
title: Index Markdown, HTML and Word documents, through loaders
status: Proposed
release: '—'
created: 2026-09-27
updated: 2026-09-27
---

# 0046 — Index Markdown, HTML and Word documents, through loaders

## Summary

A knowledge base takes Markdown, HTML and Word (`.docx`) files as well as
PDFs, and answers from them with the same citations. Each format is a
**loader**: a module that turns a file's bytes into the per-page elements the
PDF pipeline already produces, so chunking, retrieval, parents and citations
are shared. A developer adds a format by writing one loader.

## Problem / motivation

Ingestion is PDF from end to end. `ingestDocument` calls `chunksFromPdf`
(`src/lib/rag/crack.ts`), which opens the bytes with `unpdf`; the upload
allow-list is `['application/pdf']` (`src/lib/rag/constants.ts`); the title
strips `.pdf`; the page image and source routes return 404 for anything else.
Much of what people want to ask questions of lives in Markdown, web pages and
Word documents (#142). Upload validation also trusts the browser's `file.type`,
with no check of the bytes.

The PDF path already has a format-neutral middle: the layout step turns
positioned text into `ParsedElement[]` per page (`layout.ts` `toElements`,
`parse-types.ts`), and `normalizePage` + `chunkElements` take it from there.
That is the seam.

## Goals

- Markdown, HTML and `.docx` upload, index and answer with citations.
- A new format is one loader module and one line in a registry.
- PDF behaviour is unchanged.
- Uploads are accepted by what the bytes are, not what the browser says.

## Non-goals

- **Rendering non-PDF pages as images** or highlighting in them. A citation to
  a non-PDF shows its passage text.
- **Web pages by URL.** Spec 0047 fetches a URL and hands the HTML to this
  spec's HTML loader.
- **Other formats** (PowerPoint, spreadsheets, EPUB). Each would be a loader.
- **OCR** of images inside Word files.

## Requirements

### Functional

- **FR1** — A `DocumentLoader` has the MIME type and extensions it accepts, a
  `sniff(bytes)` that says whether bytes are its format, its `unit`
  (`'page' | 'section'`), and `toChunks(bytes, options)` returning the same
  `DocumentChunks` the PDF pipeline returns. Text formats build sections of
  elements and share `sectionsToChunks` (normalise, then `chunkElements`).
  Amended while building: returning chunks rather than elements lets PDF keep
  its own path (cracking, figures, boxes) untouched.
- **FR2** — A loader registry maps an upload to its loader. The PDF loader is
  today's `chunksFromPdf` path, unchanged, cracking included.
- **FR3** — The Markdown loader splits a document into sections at headings
  (`#` to `###`); each section is a page. Headings become heading elements,
  lists and tables their own elements, fenced code a single element.
- **FR4** — The HTML loader drops scripts, styles and navigation, and maps
  `h1`–`h3`, paragraphs, list items, tables and `pre` to elements, sectioned
  like Markdown.
- **FR5** — The Word loader reads `.docx` paragraphs with their heading styles
  and tables, sectioned like Markdown.
- **FR6** — Uploads are identified by their bytes (`sniff`): a file whose
  bytes match no loader is refused with the formats accepted, whatever its
  name or claimed type. The stored MIME type is the loader's.
- **FR7** — A non-PDF document's citations and inspector say "section" where a
  PDF says "page", and its source view shows the passage text; the page-image
  and PDF source routes stay PDF-only.
- **FR8** — The title drops the file's own extension, whatever it is.

### Non-functional

- **NFR1** — PDF ingestion, retrieval and citations are unchanged: the existing
  ingestion, chunking, citation and inspector tests pass unmodified.
- **NFR2** — A loader runs on the server with the same size limit as a PDF and
  never executes content (no scripts, no macros).
- **NFR3** — New dependencies are limited to one maintained HTML parser and one
  `.docx` reader.

## Design / approach

- `src/lib/rag/loaders/types.ts`: `DocumentLoader`, `LoadedDocument`.
- `src/lib/rag/loaders/index.ts`: the registry; `loaderForBytes(bytes)`.
- `src/lib/rag/loaders/pdf.ts`: wraps `chunksFromPdf`. PDF stays on its own
  path through `crack.ts` so cracking, figures and bounding boxes are untouched;
  the other loaders go through `normalizePage` + `chunkElements`.
- `markdown.ts`, `html.ts`, `docx.ts`: bytes to sectioned `ParsedElement[]`,
  with no bounding boxes.
- `ingest.ts`: picks the loader from the stored MIME type. `documents.page_count`
  holds the section count for a non-PDF.
- `actions.ts`: `sniff` replaces `file.type`; the allow-list comes from the
  registry. `constants.ts` `DOCUMENT_MIME_TYPES` becomes derived.
- Citations: the unit (`page` / `section`) is derived from the document's MIME
  type where it is displayed; no schema change.

## Acceptance criteria

- [x] FR1, FR2: PDF goes through the registry unchanged — `rag-loaders.test.ts` _"picks each format from its content"_; PDF ingests through `pdfLoader` (`chunksFromPdf`) in the RAG e2e suite
- [x] FR3: a Markdown file is sectioned at headings and answers with a citation — `rag-loaders.test.ts` _"Markdown"_ and _"turning a document into chunks"_; e2e `loaders.spec.ts` (`leave-policy.md`)
- [x] FR4: an HTML file drops script, style and nav, and answers with a citation — `rag-loaders.test.ts` _"drops script, style, nav and footer"_; e2e `loaders.spec.ts` (`leave-policy.html`)
- [x] FR5: a `.docx` file keeps its headings and tables, and answers with a citation — `rag-loaders.test.ts` (`leave-policy.docx`: headings from styles, the table); e2e `loaders.spec.ts`
- [x] FR6: a renamed file whose bytes are not an accepted format is refused — `rag-loaders.test.ts` _"refuses bytes no format recognises"_; `uploadDocument` sniffs before storing
- [x] FR7: a non-PDF citation says "section" and shows the passage text — e2e `loaders.spec.ts`: the chip reads `§2` and the source panel shows the section's text with no page image; the inspector labels sections and skips page images
- [x] FR8: titles drop any extension — `actions.ts` strips any extension
- [x] NFR1: the existing ingestion, chunking, citation and inspector tests pass unmodified — the existing unit suite and the RAG, chat, knowledge-base, quickstart and isolation e2e suites pass (17 e2e) with only upload-label strings updated

## Security & privacy

Uploaded files are untrusted. Loaders parse text only: the HTML loader never
runs scripts or fetches linked resources, the Word loader never runs macros
and ignores embedded objects. Identifying uploads by their bytes closes the
gap where a client-declared type decided which parser saw a file. Loaded text
reaches models fenced like PDF text (#126).

## Alternatives considered

- **Convert every format to PDF first** (e.g. with LibreOffice) and reuse the
  PDF path as it is. Keeps one path, but adds a large binary to the image and a
  slow conversion step, and turns structured text into positioned text only to
  recover the structure again.
- **One general text loader** that ignores structure. Simpler, but headings are
  what section parents and citations are built on (spec 0033).

## Out of scope / future

- URLs (spec 0047), more formats, OCR, image rendering for non-PDF citations.

## References

- #142 (capability), #145 (this spec); spec 0031 (layout, elements), spec 0033
  (sections and parents), spec 0037 (the inspector).
