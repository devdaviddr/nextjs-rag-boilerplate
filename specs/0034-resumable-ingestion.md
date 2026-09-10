---
id: 0034
title: Resumable ingestion
status: Proposed
release: '—'
created: 2026-09-10
updated: 2026-09-10
---

# 0034 — Resumable ingestion

## Summary

Ingestion runs out-of-band from the upload request via `after()`, with no queue
and no worker — a stance the boilerplate took deliberately and which held for
three specs. Document cracking broke the assumption it rested on. A restart
mid-ingestion now strands a document in `extracting` or `embedding` forever,
with no retry and no way back except deleting and re-uploading.

This spec makes ingestion **resumable**. It does not necessarily make it a
queue: the smallest change that removes the stranding is a claim-and-retry loop
over `documents.status`, and a queue is only warranted if that proves
insufficient.

## Problem / motivation

`src/lib/rag/ingest.ts` states the original reasoning:

> Runs out-of-band from the request that triggered it: a 200-page PDF is
> hundreds of embedding calls against a rate-limited endpoint, which cannot
> happen inside a Server Action. No queue and no worker container — the
> boilerplate's deliberate "no queue" stance from spec 0007 still holds at this
> scale, and `documents.status` is what the UI polls.

**"At this scale" no longer describes the workload.** With
[`0031`](0031-tables-figures-and-complex-layouts.md) enabled, ingestion is one
parse call per routed page plus a vision call per caption-less figure. An
8-page document measured **51 seconds**; a 25-page one at the cracking budget
will be minutes. The window in which a deploy, a crash or a container restart
can land mid-ingestion went from seconds to minutes, and the deploy story for
this project is a pull timer that restarts the container.

The consequence is already documented in `docs/rag.md` under Known gaps:

> A process restart mid-ingestion strands a document in a transient status.

There is no recovery path. `documents.status` is `extracting`, nothing is
running, and nothing will ever run again for that row. The UI polls forever.
`pagesProcessed` (0031 FR13) tells a user _how far it got_ before it stopped,
which makes the stranding legible without making it recoverable.

There is a second cost. Re-ingesting a failed document re-pays every parse call
from page 1, because nothing is cached — the delete-then-insert transaction that
makes retries idempotent also makes them expensive.

## Goals

- A document never remains in a transient status with nothing working on it.
- Ingestion resumes rather than restarting, so a retry does not re-pay for pages
  already cracked.
- Concurrent workers cannot both ingest the same document.
- The single-container deployment still works with no new services.

## Non-goals

- A distributed job system. If a claim-and-retry loop over Postgres suffices,
  that is the answer; a broker is a cost this boilerplate should pay only on
  evidence.
- Changing the ingestion pipeline itself — routing, cracking and chunking are
  [`0031`](0031-tables-figures-and-complex-layouts.md)'s and stay as they are.
- Real-time progress push. Polling `documents.status` is adequate and is what
  the UI already does.

## Requirements

### Functional

- **FR1** — A document in a transient status with no live worker is detected and
  retried, without user action.
- **FR2** — Retry is bounded. A document that fails repeatedly reaches `failed`
  with a user-readable reason rather than cycling forever.
- **FR3** — Ingestion resumes from the last completed page. A document that
  cracked 20 of 25 pages before a restart does not re-pay for those 20.
- **FR4** — Two processes cannot ingest the same document concurrently.
- **FR5** — The existing idempotence guarantee holds: a completed ingestion
  produces exactly one set of chunks, never duplicates (spec 0025 NFR5).
- **FR6** — Works with one app container and no additional services.

### Non-functional

- **NFR1** — No new required infrastructure. Postgres is already a hard
  dependency; anything else must be optional.
- **NFR2** — Recovery must not stampede. A restart with fifty stranded
  documents must not fire fifty concurrent cracking runs at a rate-limited
  endpoint.
- **NFR3** — A stranded document is visible as such before it is recovered —
  "stuck and being retried" and "still working" must be distinguishable.

## Design / approach

### The smallest thing that removes the stranding

Two columns on `documents`:

```
claimed_at    timestamp   -- when a worker took this document
attempts      integer     -- how many times it has been tried
```

A worker claims with a conditional update — `SET claimed_at = now() WHERE id = ?
AND (claimed_at IS NULL OR claimed_at < now() - interval '10 minutes')` — which
gives FR4 for free from Postgres's own row locking, with no broker. On boot and
on a timer, a sweep looks for transient-status rows whose claim has expired and
re-runs them, bounded by `attempts` (FR2) and by a small concurrency limit
(NFR2).

This is the same shape as the deployment's existing pull timer: something checks
periodically and acts. It adds no service.

### Resuming rather than restarting (FR3)

`documents.extraction` already records, per page, which route it took and what
happened — that is the resume log, written by
[`0031`](0031-tables-figures-and-complex-layouts.md) for a different reason. A
resumed run can skip pages already recorded as `parsed`, provided the parsed
output for those pages survives.

It currently does not: `crackDocument` returns chunks in memory and only the
final transaction persists anything. Options, in increasing cost:

1. **Persist chunks per page** as they are produced, rather than in one final
   transaction. Cheapest, but it breaks the delete-then-insert idempotence
   (FR5) unless the delete is scoped per page.
2. **Cache parsed elements** keyed by `fileId` and page, so a resume re-embeds
   but does not re-parse. Parse calls are the expensive half; embedding is
   cheap and rate-limited but not billed.
3. **Cache the rendered page images.** Saves render time, not API calls. Least
   valuable.

Option 2 is the recommendation: it targets the actual cost, leaves the
transaction boundary intact, and a stale cache is harmless because parse output
is a pure function of the page image.

### What a reviewer must not get wrong

**The claim window is not a lock.** A worker that hangs for longer than the
window will have its document claimed by another, and both will finish. FR5 is
what makes that safe — the final delete-then-insert is atomic, so the second
writer wins and neither leaves duplicates. If the resume work in FR3 breaks that
transaction boundary, the claim window stops being safe, and the two
requirements have to be re-reconciled rather than one quietly dropped.

## Acceptance criteria

- [ ] A document left in `extracting` with an expired claim is picked up and
      completed without user action — `tests/unit/rag-ingest-recovery.test.ts`
- [ ] A document that fails `N` times reaches `failed` with a readable reason
      and is not retried again
- [ ] Two concurrent workers cannot both claim the same document
- [ ] A resumed ingestion issues no parse call for a page already recorded as
      `parsed` in `documents.extraction`
- [ ] A completed ingestion has exactly one set of chunks after any number of
      interruptions and retries
- [ ] A restart with many stranded documents recovers them under a concurrency
      limit rather than all at once
- [ ] Verified against the Docker stack: kill the container mid-ingestion of a
      multi-page cracked PDF, restart, and the document reaches `ready`
- [ ] `docs/rag.md`'s Known gaps entry about stranded documents is removed

## Security & privacy

Recovery must respect the same ownership as the original ingestion — a sweep
runs as the system and must not become a path that ingests one user's file into
another's knowledge base. `documents.ownerId` and `knowledgeBaseId` are already
read from the document row rather than a session, which is the property to
preserve.

An attempts cap also bounds a denial-of-service shape: a file that reliably
crashes the parser must not be retried forever against a shared rate limit.

## Alternatives considered

- **A real queue (pg-boss, BullMQ).** More capable, and pg-boss needs no new
  service. It is the right answer if the claim-and-retry loop proves
  insufficient — but adopting a job framework to fix "nothing retries a stranded
  row" is a large answer to a small question, and the boilerplate's audience
  pays for that complexity forever.
- **Leave it, document it.** The status quo. Acceptable while ingestion took
  seconds. With cracking it is minutes, and the deploy model restarts the
  container.
- **Ingest synchronously in the Server Action.** Impossible at this duration and
  the reason `after()` exists.
- **Recover only on boot, not on a timer.** Simpler, and misses a document
  stranded by a worker crash that did not take the process down.

## Out of scope / future

- Progress push over websockets or SSE.
- Multi-container horizontal scaling. The claim window makes it _safe_, but
  in-memory rate limiting ([`0017`](0017-shared-store-rate-limiting.md)) is the
  blocker there, not ingestion.
- Cancelling an in-flight ingestion from the UI.

## References

- `src/lib/rag/ingest.ts` — the `after()` stance and its "at this scale"
  qualifier.
- [`0031`](0031-tables-figures-and-complex-layouts.md) — per-page routing,
  `documents.pages_processed` and `documents.extraction`, which is the resume
  log this spec reuses.
- `docs/rag.md` — Known gaps, "A process restart mid-ingestion strands a
  document in a transient status".
