---
id: 0041
title: Read the platform documentation inside the app
status: Proposed
release: '—'
created: 2026-09-25
updated: 2026-09-25
---

# 0041 — Read the platform documentation inside the app

Tracked in [#52](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/52):
[#59](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/59) (build and
link check),
[#60](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/60),
[#61](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/61),
[#62](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/62).

## Summary

Add a **Docs** section to the app where signed-in users read how the platform
works: what it is, its architecture, features, how to use it, the database,
retrieval and operations. It renders the repo's own `docs/*.md` at build time,
so the docs have one source and cannot drift from what ships.

## Problem / motivation

The documentation is good and extensive — 16 pages, ~6,400 lines, 12 Mermaid
diagrams, 3 screenshots — but it lives only in the repository. Someone using a
deployed instance has to find the GitHub repo to learn what the app does, how
citations work, or why an answer was refused. Operators reading about backups
or deployment are in the same position.

## Goals

- A Docs item in the sidebar and a `/docs` index grouped by what the reader
  wants to know.
- Pages that read like a docs site: tables, code, a table of contents, working
  links, images and rendered diagrams.
- No second copy of the content, and a CI check that keeps its links honest.

## Non-goals

- Editing docs in the app.
- A public, unauthenticated docs site (decision 3).
- Answering questions about the docs with the RAG itself — a good idea, and a
  separate spec.

## Requirements

### Functional

- **FR1 — Index.** `/docs` lists every `docs/*.md` page in a section, with a
  one-line description taken from its **What this covers** line, or its first
  paragraph where it has none (database, RAG, tutorial):
  - **About** — summary
  - **Using the app** — tutorial, usage
  - **Features** — features, PWA, push, email, OAuth
  - **Architecture & retrieval** — architecture, RAG
  - **Data** — database, backups
  - **Operations** — self-hosting, deployment, CI/CD, workflow

  A sidebar item **Docs** links to it. Pages have previous / next links in
  index order.

- **FR2 — Rendering.** `/docs/[slug]` renders the page with the app's existing
  markdown stack (react-markdown + remark-gfm, **no raw HTML**), heading anchors
  and an on-page table of contents.
- **FR3 — Links and images.**
  - `x.md#frag` becomes `/docs/x#frag`, and `#frag` keeps working on the same
    page.
  - Links out of `docs/` (README, `specs/`, source files) go to GitHub at the
    running commit (`APP_GIT_SHA`, falling back to `main`).
  - `docs/images/*` are served.
  - The "← Back to README" lines are replaced by the in-app index.
- **FR4 — Diagrams.** Mermaid blocks render client-side, lazily, following the
  light/dark theme. A block that fails to render shows its source.
- **FR5 — Build.**
  - Pages are generated at build time (`generateStaticParams`), with no
    filesystem reads at request time.
  - `pnpm docs:check` fails on any relative link or `#anchor` that does not
    resolve, and runs in CI's quality job.
- **FR6 — Access.** Signed-in users only (the dashboard route group); every
  section, Operations included, is visible to every signed-in user.
- **FR7 — Search (phase 2).** A build-time index (page, heading, text) searched
  in the browser; results link to the page and heading.

### Non-functional

- **NFR1** — No new client bundle cost on non-docs pages. Mermaid (~600 KB) loads
  only on a page that has a diagram.
- **NFR2** — Works under the existing CSP. `script-src` uses a nonce; Mermaid is
  bundled, not inlined, and `style-src` already allows inline styles.
- **NFR3** — The docs remain readable on GitHub unchanged. The app adapts to
  them, not the reverse.

## Design / approach

- **Content loading.** `src/lib/docs/` reads `docs/*.md` at build time into
  `{ slug, title, summary, section, body }`. The section map is a small
  hand-kept table (FR1), and a test fails if a doc exists that is not in it.
- **Rendering.** Reuse `components/chat/markdown.tsx`'s configuration (safe, no
  `rehype-raw`), adding `rehype-slug` for anchors, a heading walk for the table
  of contents, a link transformer (FR3), and a `code` renderer that hands
  `mermaid` blocks to a lazy client component.
- **Images.** Copy `docs/images/` to `public/docs-assets/` in a `prebuild` step,
  or serve them from a traced route. Copying is simpler and cache-friendly.
- **Link check.** `scripts/docs-check.mjs` parses each doc and resolves every
  relative target and anchor, using the same slug function as the renderer, so
  the check and the app cannot disagree.
- **Shell.** Add `{ title: 'Docs', href: '/docs', icon: BookOpen }` to
  `src/lib/shell/nav.ts`.

## Acceptance criteria

- [x] FR1: every file in `docs/` is reachable from `/docs` in its section; a test
      fails for an unmapped doc — `tests/unit/docs-lib.test.ts` _"maps every
      docs/\*.md exactly once"_, `pnpm docs:check`, `tests/e2e/docs.spec.ts`
      _"the index lists every section"_
- [x] FR2: all 16 pages render with anchors and a table of contents; no raw HTML
      is rendered — `DocMarkdown` uses remark-gfm + rehype-slug with no
      `rehype-raw`; ids match `docs:check`'s (_"produces the ids rehype-slug
      gives"_); TOC tested in _"a page renders its diagrams, contents and in-app
      links"_
- [x] FR3: every relative link resolves in-app (`pnpm docs:check`: 16 docs, 351
      links, 0 failures); out-of-docs links go to GitHub at `APP_GIT_SHA`
      (`resolveDocHref`, unit-tested); images are served by `/docs-assets`
      (no current doc embeds one — README's screenshots live in `docs/images`)
- [x] FR4: all 12 Mermaid diagrams render in light and dark themes; a broken one
      shows its source — e2e checks every diagram on database, rag and
      architecture (light) and rag (dark) with no CSP errors;
      `tests/unit/docs-mermaid.test.tsx` covers the fallback
- [x] FR5: `pnpm docs:check` runs in CI (quality job, docs-only PRs included);
      docs ship in the image via `outputFileTracingIncludes` — see _As built_
- [x] FR6: signed-out users are redirected to sign in; `/docs-assets` returns
      401 — e2e _"signed-out visitors are sent to sign in"_
- [x] NFR1: Mermaid is absent from the bundle of pages without diagrams —
      imported only by `import('mermaid')` inside `MermaidDiagram`, which only
      `DocMarkdown` renders

### As built (2026-09-25)

**FR5 deviates from "static at build time".** The docs live under the
dashboard route group, whose layout reads the session on every request, so the
pages render per request. `src/lib/docs` reads `docs/*.md` once per process and
keeps it in memory (re-read in development, so edits show live); the files are
traced into the image by `outputFileTracingIncludes`, with `turbopackIgnore` on
the `process.cwd()` path so the tracer does not copy the whole project (#16).
Same guarantee — the content ships with the build — for one ~250 KB read per
process.

**`/docs-assets` checks the session itself**: the proxy's matcher skips paths
with an image extension, so the protected-prefix check never ran for them.

## Security & privacy

- The docs describe the system in detail, including self-hosting, backups and
  the security model. They are already public in the repository, so exposing
  them to signed-in users adds nothing an attacker could not read on GitHub.
  An instance built from a private fork keeps them behind sign-in (FR6).
- No raw HTML rendering, so a doc cannot inject script.

## Alternatives considered

- **A separate docs site (Nextra, Docusaurus).** A second build and deployment,
  and it does not live where users already are.
- **Link to GitHub.** No work, but it sends users out of the product, and a
  private fork's repo may not be visible to them.
- **Render at request time from the filesystem.** Needs the docs traced into the
  image and a read per request; static generation is simpler and faster.

## Decisions (reviewed 2026-09-25)

1. **Every signed-in user sees every section, Operations included.** The content
   is public in the repository, and an admin-only split adds rules for little
   gain (FR6).
2. **`specs/` is not browsable in the app.** Specs are design records for
   contributors; docs link to them on GitHub (FR3).
3. **`/docs` requires sign-in in v1.** A public-docs flag can follow if wanted.
4. **Search is phase 2** (FR7, #62). Sixteen pages with a grouped index are
   navigable without it.

## Out of scope / future

- Ask-the-docs: index `docs/` as a built-in knowledge base and answer questions
  about the platform with the RAG pipeline itself.
- Versioned docs per release.

## References

- `docs/` — the content (16 pages)
- `src/components/chat/markdown.tsx` — the safe markdown configuration to reuse
- `src/lib/shell/nav.ts` — sidebar items
- `src/proxy.ts` — CSP
