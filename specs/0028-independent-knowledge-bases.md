---
id: 0028
title: Independent knowledge bases
status: Shipped
release: 'v0.20.0'
created: 2026-09-08
updated: 2026-09-08
---

# 0028 — Independent knowledge bases

## Summary

Today every PDF a user uploads lands in **one flat pool**, and every question
searches all of it. This spec gives a user **several independent knowledge
bases**: create them, upload a PDF _into_ one, and choose which one (or several)
a conversation is allowed to search.

The change is smaller than it looks — the chunking and embedding pipeline needs
**zero** changes — and more dangerous than it looks, in one specific place. The
danger is not cross-user leakage; `owner_id` already prevents that and is not
weakened here. It is **cross-KB leakage inside a single account**, which no
existing test could catch and which does not look like a security bug when you
meet it. It looks like retrieval being slightly too generous.

## Problem / motivation

The flat pool is fine with three documents and wrong with thirty.

**Unrelated documents interfere.** A staff handbook and a set of client
contracts in one pool means every question searches both. The evaluation corpus
already demonstrates the mechanism deliberately: the facilities guide's staff
parking sits on the same street as the handbook's fire assembly point, and that
overlap is there precisely because retrieval gets harder as unrelated content
accumulates. Real users hit this by accident rather than by design.

**There is no way to exclude anything.** A user with a KB they consider
confidential — performance reviews, medical letters — has no way to keep it out
of most conversations while still being able to ask about it in one. Today the
only scoping tool is "summarise `<title>`", which narrows to one document and
only for whole-document questions.

**Scope is invisible.** An answer cites a document, but nothing records what the
question was _allowed_ to search. Once [`0029`](0029-agentic-retrieval-loop.md)
lets a model run several searches per question, "what was in scope for this
answer" becomes something we need to have written down rather than inferred.

## Goals

- A user can create, rename and delete knowledge bases, and move a document
  between them **without re-ingesting it**.
- A PDF is uploaded into exactly one knowledge base.
- A conversation searches a chosen set of knowledge bases, and provably cannot
  retrieve outside it.
- Existing documents and conversations keep behaving exactly as they do today
  after migration — no user notices a behavioural change unless they opt in.
- The evaluation harness can measure **cross-KB leakage**, which it currently
  cannot detect even in principle.

## Non-goals

- **Sharing a knowledge base between users.** Everything stays single-owner.
- **Per-KB storage quotas.** The existing per-user quota is unchanged.
- **A document belonging to two knowledge bases at once.** See _Alternatives_.
- **Changing which KBs a conversation searches, mid-thread.** Deferred, with
  reasons, to _Out of scope_.
- **Any agentic behaviour.** That is [`0029`](0029-agentic-retrieval-loop.md).
  This spec only defines the boundary that spec's search tool must respect.

## Requirements

### Functional

- **FR1** — A user can create a knowledge base with a name and optional
  description; rename it; and delete it.
- **FR2** — Deleting a knowledge base deletes its documents, their chunks, and
  **their S3 objects**. The S3 objects are not covered by any database cascade
  and must be removed explicitly, before the cascade runs.
- **FR3** — A document is uploaded into a specific knowledge base. Upload
  happens from inside that KB's page, so the target is never ambiguous.
- **FR4** — A document can be **moved** to another knowledge base the same user
  owns. Moving re-tags rows only: no re-extraction, no re-chunking, and no
  re-embedding.
- **FR5** — A conversation carries a set of knowledge bases, chosen when it is
  created. New conversations default to **all** of the user's knowledge bases.
- **FR6** — Retrieval returns only chunks whose `knowledge_base_id` is in that
  conversation's set. This holds for the dense channel, the lexical channel,
  whole-document scoping, and document listing used by scope resolution.
- **FR7** — A user with **zero** knowledge bases is told so in the composer and
  cannot send a question. A user who explicitly selects **none** gets a refusal
  that short-circuits _before_ any embedding call is made.
- **FR8** — `/documents` lists knowledge bases; `/documents/[kbId]` lists that
  KB's documents and is where upload happens.

### Non-functional

- **NFR1** — The knowledge-base filter is a scalar equality in the same `WHERE`
  clause as `owner_id`, in every query. Never a join, never a post-hoc filter on
  results.
- **NFR2** — Retrieval does not regress into a sequential scan. The composite
  index must serve both owner-only and owner+KB predicates.
- **NFR3** — An empty knowledge-base set is an explicit, tested state. It must
  never be interpretable as "no filter".
- **NFR4** — `pnpm rag:eval` gains a cross-KB leakage metric, and the run fails
  if it is ever non-zero.
- **NFR5** — Migration is idempotent-safe to run unattended (`docker compose
up` runs pending migrations with no human present) and fails loudly rather
  than silently mis-filing data.

## Design / approach

### Schema

Three changes, one new table.

```ts
// knowledge_bases — new
id, ownerId → users.id (cascade), name, description (nullable),
createdAt, updatedAt
index: knowledge_bases_owner_id_idx (ownerId)

// documents — one new column
knowledgeBaseId → knowledge_bases.id (cascade), NOT NULL
index: documents_knowledge_base_id_idx

// chunks — one new column
knowledgeBaseId → knowledge_bases.id (cascade), NOT NULL
index: chunks_owner_kb_idx (ownerId, knowledgeBaseId)   // replaces chunks_owner_id_idx

// conversation_knowledge_bases — new join table
conversationId → conversations.id (cascade)
knowledgeBaseId → knowledge_bases.id (cascade)
primary key (conversationId, knowledgeBaseId)
index: conversation_kb_kb_id_idx (knowledgeBaseId)   // reverse lookup
```

**Why `chunks` carries a denormalised `knowledge_base_id`.** For exactly the
reason it already carries a denormalised `owner_id`, and the existing comment in
`src/db/schema.ts` says it better than a new one would: a join is one refactor
away from being dropped. Concretely, both retrieval channels query `chunks`
directly — the dense channel orders by `embedding <=> $q` under an HNSW index
with the owner predicate applied _after_ the ANN scan, and the lexical channel
runs a GIN bitmap scan. Adding the KB predicate via a join to `documents` puts a
per-candidate lookup on the hot path, and as data grows invites the planner to
abandon the index path entirely. That is the same failure shape as the
`vector`/`halfvec` trap this project already documents: correct results,
silently degrading performance, no error anywhere.

The composite index leads with `ownerId`, so owner-only queries still use it and
nothing regresses.

**One knowledge base per document.** A many-to-many would make a chunk's KB
membership non-scalar, forcing either the join above or a duplicate chunk row —
and therefore a duplicate 2048-dimension embedding — per membership. Neither is
acceptable. FR4's `moveDocument` exists to make this cheap to live with: filing
a document wrongly should cost a `WHERE` clause, not hundreds of rate-limited
embedding calls.

**A join table, not a `jsonb` array, for the conversation's selection.** The
array is simpler to read and gives no referential integrity: delete a KB and
every conversation that ever selected it keeps a dangling id, cleaned up by
app-level sweep code. This schema avoids that kind of bookkeeping everywhere
else. The join table gets `ON DELETE CASCADE` free. It is read once per chat
page load, not once per retrieval query, so the join costs nothing that matters.

**Cross-table invariant.** A document's owner and its KB's owner must match.
Postgres cannot express this without a trigger, so every write path that assigns
a document to a KB (`uploadDocument`, `moveDocument`) verifies
`knowledgeBase.ownerId === session.user.id` first — the same shape as the
existing ownership checks in `src/lib/rag/actions.ts`.

### Retrieval

One query, filtered. `AND c.knowledge_base_id = ANY($kbIds)` goes beside the
existing `c.owner_id = $ownerId` in **all six** places that predicate appears:

| Location                      | File                      |
| ----------------------------- | ------------------------- |
| `vec` CTE                     | `src/lib/rag/retrieve.ts` |
| `lex` CTE                     | `src/lib/rag/retrieve.ts` |
| final `SELECT`                | `src/lib/rag/retrieve.ts` |
| `listReadyDocuments`          | `src/lib/rag/retrieve.ts` |
| `retrieveDocumentChunks`      | `src/lib/rag/retrieve.ts` |
| document lookup for citations | `src/lib/rag/actions.ts`  |

Adding it only to the final `SELECT` would be correct and still wrong: the CTEs'
`LIMIT $candidates` pool would be consumed by out-of-scope chunks, starving real
candidates and, at `RAG_HYBRID_CANDIDATES=20`, excluding correct results.

**`retrieveDocumentChunks` is the dangerous one.** It fetches a whole document
by id and gates on owner alone. Today that is sufficient, because owner is the
only boundary there is. Once KBs exist, a conversation scoped to KB A that
resolves a document title belonging to the same user's KB B will retrieve it —
`owner_id` never fires, because it is the same person. This is the single change
in this spec most likely to be got wrong, and it will not look like a bug.

**RRF is untouched.** Fusion combines two channels by rank position precisely
because cosine and `ts_rank_cd` are on incomparable scales. Retrieving per-KB
and fusing afterwards would need a second fusion layer across KBs of different
sizes, reintroducing the cross-scale comparison RRF exists to avoid. Filtering
the candidate pool leaves every measured property of hybrid retrieval intact.

**`RAG_HYBRID_CANDIDATES` must rise.** The filtered-ANN caveat this project
already documents — a tenant holding a small share of all chunks can get fewer
than `top_k` back, because the filter is applied after the ANN scan — gets worse
with a second narrowing predicate. A user with ten KBs searching one of them has
a much thinner candidate pool than "search everything I own" has today. Scale
the candidate pool with the number of selected KBs.

### Scope resolution

`src/lib/rag/scope.ts` needs **no code change**. It already takes an opaque,
pre-filtered document list. All the work is in the caller passing the right one.

That matters more than it sounds. `resolveScope`'s "only one document" shortcut
resolves an ambiguous "summarise this" when the user has exactly one document.
Post-KB, that must mean _one document in the selected KBs_, not one document in
the entire account — otherwise the shortcut silently stops firing for everyone
with more than one document anywhere.

### Migration

One migration (`0012`), four steps, one transaction:

1. `CREATE TABLE knowledge_bases`, `conversation_knowledge_bases`.
2. Add `knowledge_base_id` to `documents` and `chunks`, **nullable**.
3. Backfill: one KB named "My documents" per user **who already has at least one
   document**; point their documents and chunks at it; associate every existing
   conversation with it.
4. `SET NOT NULL` on both columns; create the indexes.

Users with no documents get no knowledge base. The zero-KB empty state is a real
state the UI must handle (FR7), and papering over it with a synthetic default
that every future user also receives would be worse than handling it.

**One migration, not two with a verification gate.** The textbook answer is to
gate the `NOT NULL` behind a manual check, and that answer assumes a person
watching between releases. This project's deploy model runs pending migrations
unattended on `docker compose up`, single-instance, at modest data volume. A
transactional single migration is the better trade here — but it is a trade, and
it is the one thing in this spec I would most like challenged.

The backfill must assert its own correctness before the transaction commits:

```sql
-- Must return zero rows: exactly one KB per owner after backfill.
SELECT owner_id FROM documents
GROUP BY owner_id HAVING count(DISTINCT knowledge_base_id) > 1;
```

A backfill that groups by the wrong key — per document instead of per owner —
completes "successfully" and quietly fragments every user's library into
singletons, breaking every pre-existing conversation. That is the only step in
this spec where a mistake is silent rather than loud, so it gets an assertion.

### UX

The sidebar does not grow. `nav.ts`'s single entry is relabelled to
"Knowledge bases", same href.

- **`/documents`** — a switcher: one card per KB (name, document count,
  ingestion status), a "New knowledge base" dialog, rename and delete via the
  same `DropdownMenu` pattern the recents list already uses.
- **`/documents/[kbId]`** — today's documents panel, scoped. Upload lives here
  and targets this KB implicitly, which is why FR3 needs no KB picker.
- **The composer** — a `DropdownMenuCheckboxItem` multi-select summarising the
  selection ("All knowledge bases" / "2 selected: Handbook, Contracts"). Both
  primitives already exist; no new dependency.
- **Zero KBs** — inline empty state in the chat view with a button opening the
  create dialog. Send is disabled. Letting the request go and returning a canned
  refusal is a strictly worse version of the same guarantee.
- **None selected** — short-circuit before `embedQuery()`. An empty set cannot
  produce a candidate row, so there is no reason to spend an embedding call
  discovering that. This is cheaper than today's refusal path, which pays for
  the embedding before the similarity floor rejects everything.

### The boundary 0029 must respect

Stated here because the boundary is defined by this spec and consumed by that
one:

> `search_documents` resolves **both** `ownerId` (from the session) **and** the
> permitted `knowledgeBaseIds` (from the conversation's stored selection)
> server-side, at the top of the request. The model may supply `query` and
> optionally a narrowing `documentId`. It supplies nothing that decides _where_
> it may search, and nothing it emits — a KB name, an id, a hint echoed from
> retrieved content — is ever honoured as a scope override.

A model-supplied `documentId` is validated against owner **and** the permitted
set, and a document outside that set returns exactly what a missing one returns.
The codebase already makes this distinction deliberately — `deleteDocument`
returns the same response whether a document is missing or someone else's,
specifically to avoid an existence signal. Extend the same rule: _missing,
someone else's, or outside this conversation's selection are indistinguishable._

This matters more than the owner case, and differently. `owner_id` stops a
confused or injected planning step from crossing into another user's data. It
does nothing to stop it crossing into KBs **this** user deliberately excluded —
which may be the whole reason they made a separate KB.

## Acceptance criteria

Each box cites the evidence that closed it, so a tick can be re-checked rather
than taken on trust.

- [x] A user can create, rename, delete a KB, and move a document between KBs.
      — `tests/e2e/knowledge-bases.spec.ts` covers create, move and delete;
      `tests/unit/kb-actions.test.ts` covers rename, including that it refuses a
      knowledge base owned by someone else with the same error a missing one
      gets, so the action cannot be used to probe which ids exist.
- [x] Moving a document issues no embedding calls (assert on the NIM client).
      — `tests/e2e/knowledge-bases.spec.ts` proves it more strongly than the
      criterion asked: it snapshots the chunk rows before and after the move and
      asserts identical ids and `created_at`. Re-embedding could not leave those
      untouched.
- [x] Deleting a KB removes its S3 objects, verified against the bucket, not
      only its database rows. — `tests/e2e/knowledge-bases.spec.ts`, "deleting a
      knowledge base removes its documents, chunks, and S3 object", which
      queries the bucket with a real `S3Client`.
- [x] Uploading from `/documents/[kbId]` files the document in that KB, and
      every chunk carries the same `knowledge_base_id`. —
      `tests/e2e/knowledge-bases.spec.ts` asserts every chunk row carries the
      uploading KB's id.
- [x] Unit test: the generated SQL contains a `knowledge_base_id` predicate in
      the dense CTE, the lexical CTE, and the final select — asserted against
      the SQL text, following the existing owner-isolation test. —
      `tests/unit/rag-retrieve.test.ts`, "knowledge-base isolation (spec 0028
      FR6, NFR1)", one test per clause.
- [x] Unit test: an empty `kbIds` array never produces a query without a KB
      predicate. — `tests/unit/rag-retrieve.test.ts` asserts `retrieveForOwner`,
      `listReadyDocuments` and `retrieveDocumentChunks` each return `[]`
      immediately, with no embedding call and no query issued at all.
- [x] Unit test: `retrieveDocumentChunks` with a document id outside the
      permitted set returns nothing. — `tests/unit/rag-retrieve.test.ts`,
      "the dangerous one (spec 0028)".
- [x] E2E: two KBs, a document in each; a chat scoped to A cannot answer a
      question only answerable from B, and answers it when both are selected.
      — `tests/e2e/knowledge-bases.spec.ts`, "cross-knowledge-base isolation".
- [x] E2E: a question naming a document by title in an unselected KB does not
      resolve to it. — same test, third leg.
- [x] Migration on a populated database: every document and chunk ends in
      exactly one KB per owner; the assertion query returns zero rows; every
      pre-existing conversation retrieves what it retrieved before. —
      `drizzle/0012_messy_bucky.sql` enforces this at migration time: a `DO`
      block raises on a fragmented owner, an orphaned document or an orphaned
      chunk, so the migration cannot commit unless the property holds. Prior
      conversations are backfilled against every KB their owner had.
- [x] `pnpm rag:eval` reports **cross-KB leakage = 0** and fails the run
      otherwise. — `eval/run.ts`, "Cross-KB leakage + complement check (spec
      0028 NFR4)".
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass. —
      re-verified 2026-09-09.

## Security & privacy

The tenant boundary is unchanged and unweakened: `owner_id` remains a `WHERE`
clause repeated in every channel. This spec adds a **second, weaker boundary
inside one account**, and the two must not be confused.

- **Cross-user** — unchanged. No new path.
- **Cross-KB, same user** — new. Enforced the same way, in the same clause. Not
  a confidentiality boundary against an attacker who controls the account; it is
  a scoping boundary the account holder chose. Worth stating plainly so nobody
  later mistakes it for the former.
- **Existence disclosure** — out-of-scope documents are indistinguishable from
  missing ones.
- **Injection** — an uploaded PDF reaching the model as context can attempt to
  widen scope. It cannot, because scope is never read from model output. This is
  why the invariant above is written as a property of the server, not of the
  prompt.

## Alternatives considered

- **Many-to-many documents ↔ KBs.** Rejected: makes a chunk's KB membership
  non-scalar, forcing a hot-path join or duplicated embeddings. `moveDocument`
  recovers most of the practical benefit at a fraction of the risk.
- **`jsonb` array of KB ids on `conversations`.** Rejected: no referential
  integrity, dangling ids after a KB delete, app-level cleanup.
- **One query per KB, fused afterwards.** Rejected: needs a second fusion layer
  across KBs of different sizes, reintroducing exactly the cross-scale
  comparison RRF exists to avoid.
- **Per-KB slot reservation in the top-k**, so a large KB cannot drown out a
  small one. Deferred, deliberately: it is an unmeasured heuristic, and this
  project has already been burned once by a plausible-sounding retrieval change
  that improved every metric except the one that mattered. Add the eval case
  first, then decide.
- **Unique KB names per owner.** Not enforced. Duplicate names are legitimate
  (a "Taxes" per year), and a rename colliding is a loud failure for a cosmetic
  problem. The cards show counts and dates to disambiguate. Easy to add later.

## Out of scope / future

- **Changing a conversation's KB selection mid-thread.** Fixed at creation in
  v1. Two reasons beyond simplicity: every message in a thread then has one
  auditable scope, which matters once 0029 logs multi-search traces; and it
  removes a real race where a user changes the picker while a multi-search loop
  is in flight, producing an answer whose citations span an inconsistent notion
  of what was permitted.
- Sharing a KB between users; per-KB quotas; KB icons.
- Background S3 sweep for very large KB deletions. A synchronous loop is fine
  at the document counts this boilerplate expects.

## References

- [`0025`](0025-rag-knowledge-base-and-chat.md) — the retrieval system extended.
- [`0026`](0026-chat-first-ux-and-history.md) — the chat surface amended.
- [`0027`](0027-agentic-rag-and-document-cracking.md) — recommendations.
- [`0029`](0029-agentic-retrieval-loop.md) — consumes the boundary defined here.
- `docs/rag.md` — filtered-ANN caveat, `halfvec` reasoning, measured baselines.
