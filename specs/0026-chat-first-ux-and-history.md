---
id: 0026
title: Rag Boilerplate — chat-first UX and conversation history
status: Proposed
release: '—'
created: 2026-09-07
updated: 2026-09-07
---

# 0026 — Rag Boilerplate: chat-first UX and conversation history

## Summary

Rename the product to **Rag Boilerplate**, and rebuild the signed-in experience
around the chat, modelled on ChatGPT: a full-width shell, a sidebar that opens
with **New chat** and lists your **recent conversations**, and chat threads that
persist so you can come back to one. Today every answer is lost on refresh and
every page is boxed into a 896px column in the middle of a 2000px window.

## Problem / motivation

Spec 0025 shipped the retrieval engine and hung a minimal UI off the
boilerplate's generic dashboard shell. Three things follow from that, all
visible in a single screenshot of the running app:

1. **The app is still called "Boilerplate."** The sidebar, the page titles, the
   PWA manifest and the landing page all say it. It reads like a template
   someone forgot to rename, not a product.
2. **Everything is boxed.** `app-shell.tsx` wraps every page in
   `mx-auto w-full max-w-4xl`. On a wide display the chat is a narrow column
   with a fixed-height box floating in the middle of the screen and a large
   empty region beneath it. The chat is the product and it looks incidental.
3. **Conversations do not exist.** There is one ephemeral thread held in React
   state. Refresh, navigate to the knowledge base and back, or close the tab,
   and the entire exchange — including the citations that justify it — is gone.
   Nothing is written to the database.

A fourth problem surfaced during verification rather than from the brief: the
model answers in Markdown, and the UI renders it as plain text inside
`whitespace-pre-wrap`, so a real answer displays as
`- **Leave:** Employees receive 20 working days...` — asterisks and all.

## Goals

- The product is called **Rag Boilerplate** everywhere a user can see a name.
- Chat is the primary surface: signing in lands you in a new chat.
- Conversations and their messages persist, scoped to their owner, and are
  listed as **Recents** in the sidebar, grouped by recency.
- A conversation can be reopened, renamed and deleted.
- The shell uses the full viewport width, while message text keeps a readable
  measure.
- Assistant answers render as Markdown.
- Citations survive a reload — they are part of the stored message, not
  transient UI state.

## Non-goals

- **Conversation search.** ChatGPT has it; it needs its own thinking (full-text
  vs vector over messages) and belongs in a later spec.
- Folders/Projects, sharing or exporting conversations, voice input, and
  per-conversation model selection.
- Attaching files inside the chat. Uploads stay in the knowledge base — the
  retrieval model is "ask across everything you have indexed", and changing
  that is a product decision, not a UI one.
- Editing or regenerating a previous message, and branching a conversation.
- Multi-turn context: each question is still answered independently. Carrying
  history into retrieval and into the prompt changes grounding behaviour and is
  deliberately separated — see Out of scope.
- Any change to retrieval, chunking, embedding or the grounding guarantee.

## Requirements

### Functional

- **FR1** — The visible product name is **Rag Boilerplate**, from a single
  exported constant rather than four hard-coded strings. Covers
  `src/app/layout.tsx` (`APP_NAME`, title template, Apple web-app title),
  `src/app/manifest.ts` (`name`, `short_name`), `src/app/page.tsx` (landing
  heading) and `src/components/shell/app-shell.tsx` (`BRAND`).
- **FR2** — `conversations` table: `id`, `ownerId` → `users.id` (cascade),
  `title`, `createdAt`, `updatedAt`. Indexed on `(ownerId, updatedAt desc)`,
  which is exactly how Recents is read.
- **FR3** — `messages` table: `id`, `conversationId` → `conversations.id`
  (cascade), `ownerId` (denormalised, as `chunks` already is, so ownership is
  never one join away from being dropped), `role` (`user` | `assistant`),
  `content`, `citations` (JSONB, `[]` for user messages), `createdAt`.
- **FR4** — `POST /api/chat` accepts an optional `conversationId`. With none, it
  creates a conversation; with one, ownership is verified before anything else.
  The user message is persisted **before** the model is called; the assistant
  message is persisted when the stream ends. The response's first NDJSON frame
  carries the `conversationId` so the client can adopt a newly-created thread.
- **FR5** — A new conversation is titled from its first user message: trimmed,
  collapsed whitespace, truncated to 60 characters on a word boundary. No model
  call — a title is not worth an inference round trip.
- **FR6** — Routes: `/chat` starts a new conversation, `/chat/[id]` opens an
  existing one (404 for someone else's, no existence signal). `/dashboard`
  redirects to `/chat`, which becomes the post-login landing.
- **FR7** — Sidebar: a **New chat** action at the top, then **Knowledge base**,
  then **Recents** — conversations grouped `Today` / `Yesterday` /
  `Previous 7 days` / `Older`, most recent first, capped at
  `CHAT_RECENTS_LIMIT` (default 50). The active conversation is highlighted.
- **FR8** — A conversation can be renamed and deleted from a row menu in
  Recents. Deleting the open conversation navigates to a new chat.
- **FR9** — The shell fills the viewport. The sidebar is a fixed-width column;
  the main region takes the remaining width with no `max-w-4xl` wrapper.
- **FR10** — Assistant messages render Markdown — headings, bold/italic, lists,
  inline code, fenced code blocks, links, tables. User messages stay plain text.
- **FR11** — An empty chat shows a centred greeting with the composer beneath
  it; once a conversation has messages the composer is pinned to the bottom and
  the transcript scrolls above it.
- **FR12** — Citations are rendered from the stored message, so reopening a
  conversation shows the same sources it was answered with.

### Non-functional

- **NFR1** — Every conversation and message query filters on `ownerId` in the
  `WHERE` clause. A test proves user B cannot read user A's conversation by id.
- **NFR2** — Markdown is rendered from **untrusted model output derived from
  untrusted document content**. Raw HTML must be disabled, and links must carry
  `rel="noopener noreferrer nofollow"`. No `dangerouslySetInnerHTML` of model
  output under any circumstance.
- **NFR3** — A disconnect mid-answer must still persist what was generated, so a
  reopened conversation is never silently missing its reply.
- **NFR4** — Message text keeps a readable measure (~`max-w-3xl`, centred)
  inside the full-width shell. "Full width" applies to the _shell_, not to
  paragraphs — line lengths of 200+ characters are harder to read, not better.
- **NFR5** — The sidebar remains usable on mobile: Recents live inside the
  existing drawer, and the composer stays reachable above the keyboard.
- **NFR6** — Recents are server-rendered on navigation, not fetched on every
  keystroke, and the list is capped (FR7) so a heavy user does not load
  thousands of rows.

## Design / approach

### Information architecture

ChatGPT's sidebar is _actions, then destinations, then history, then account_.
Mapping ours onto that:

```
┌ Rag Boilerplate ─────────┐
│  + New chat              │  action
│  ▤ Knowledge base        │  destination
│                          │
│  Recents                 │  history
│    Today                 │
│      Annual leave policy │
│    Previous 7 days       │
│      Fire safety …       │
│                          │
│  ─────────────────────   │
│  demo@example.com    ⚙   │  account: settings, theme, sign out
└──────────────────────────┘
```

`Dashboard` and `Settings` leave the primary nav: Dashboard is a boilerplate
demo page with nothing a user of _this_ product needs, and Settings belongs in
the account menu at the bottom. Dashboard is kept as a route and redirected
rather than deleted, so a fork that wants it back only reverts one line.

### Persistence and streaming

The user message is written before the model is called, so a question is never
lost even if generation fails. The assistant message is written once the stream
completes, with the citations that produced it.

`NFR3` is the subtle one: the existing route already treats a client disconnect
as unremarkable (spec 0025), and the persistence path must sit _outside_ the
`ReadableStream` consumer so an aborted socket still commits what was
generated. A conversation showing a question with no answer is a worse failure
than a truncated answer.

### Markdown rendering

`react-markdown` with `remark-gfm`, no `rehype-raw`. Model output is untrusted —
it is derived from PDFs a user uploaded, which is exactly the indirect-injection
surface spec 0025 named. Disabling raw HTML is the mitigation; a custom link
renderer adds `rel` and `target`.

### What stays exactly as it is

Retrieval, scoping, chunking, embedding, the similarity floor, the
never-call-the-model-when-nothing-matches guarantee, and tenant isolation in the
`WHERE` clause. This spec changes how answers are _presented and remembered_,
not how they are _produced_. The 0025 test suite must pass unchanged.

## Acceptance criteria

- [ ] No user-visible surface says "Boilerplate" alone: sidebar, `<title>`, PWA
      manifest, landing page.
- [ ] Signing in lands on `/chat`; `/dashboard` redirects there.
- [ ] Asking a question in a new chat creates a conversation, titles it from the
      question, and pushes it to the top of Recents without a manual refresh.
- [ ] Reloading a conversation shows the same messages **and the same
      citations**.
- [ ] Recents groups by Today / Yesterday / Previous 7 days / Older.
- [ ] A conversation can be renamed and deleted; deleting the open one starts a
      new chat.
- [ ] An automated test proves user B cannot open user A's conversation by id.
- [ ] An assistant answer containing Markdown renders as formatted text, not
      literal `**asterisks**`.
- [ ] A Markdown answer containing a raw `<script>` or `<img onerror=…>` renders
      as inert text.
- [ ] At 1920px the chat uses the full window width, with message text still
      constrained to a readable measure.
- [ ] Every spec 0025 test still passes unchanged.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass.

## Security & privacy

- **Cross-tenant reads** are the main new surface: a conversation id in a URL is
  guessable in a way a chunk id was not. Ownership is checked on every read and
  write, and the response for someone else's id is the same 404 as for a
  missing one.
- **Markdown as an injection vector.** A PDF can contain text engineered to
  produce HTML or a data-exfiltrating link in the answer. Raw HTML off, links
  rel-hardened. This narrows the surface; it does not eliminate the underlying
  indirect-injection risk named in 0025.
- **Stored conversations are new retained data.** Questions and answers persist
  until deleted; deleting a user cascades their conversations and messages.

## Alternatives considered

- **Keep chat ephemeral, add only the visual redesign.** Cheaper, but "where did
  my answer go" is the complaint underneath the brief, and a citation you cannot
  return to is worth much less.
- **Model-generated conversation titles.** Nicer titles, but an extra inference
  call per conversation against a rate-limited free tier, for a string the user
  can edit. Revisit if truncation reads badly in practice.
- **Full-bleed message text.** Rejected — see NFR4. ChatGPT itself constrains
  the message column inside a full-width shell.
- **Sanitising HTML rather than disabling it** (`rehype-raw` + `rehype-sanitize`).
  More moving parts on a path fed by untrusted documents; nothing in a
  document-QA answer needs raw HTML.
- **Deleting the Dashboard route.** Kept and redirected instead — this is a
  boilerplate, and forks may want it.

## Out of scope / future

- **Conversation search** — its own spec.
- **Multi-turn context**: using conversation history in retrieval and in the
  prompt. This genuinely changes answer behaviour and needs its own evaluation,
  which is why it is not smuggled in behind a UI change.
- Regenerate, edit-and-resend, branching, sharing, export.
- Scoping a conversation to a chosen document.

## References

- Builds on [`0025`](0025-rag-knowledge-base-and-chat.md); its behaviour is
  unchanged.
- Current constraints: `max-w-4xl` in `src/components/shell/app-shell.tsx`;
  `BRAND` in the same file; `whitespace-pre-wrap` in
  `src/components/rag/chat-panel.tsx`.
- UX reference: ChatGPT's signed-in layout — sidebar actions/history/account,
  full-width shell, centred composer on an empty thread.
