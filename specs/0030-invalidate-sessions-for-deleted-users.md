---
id: 0030
title: Invalidate sessions whose user no longer exists
status: Shipped
release: 'v0.20.1'
created: 2026-09-10
updated: 2026-09-10
---

# 0030 — Invalidate sessions whose user no longer exists

## Summary

A JWT session cookie is trusted purely on its signature: nothing ever checks
that the user it names still exists. When the `users` row is gone — the account
was deleted, a backup was restored, or the deployment was repointed at a
different database — the holder stays "signed in" as a **ghost user**. Route
protection passes, the UI renders as authenticated, and the first write fails
deep in Postgres with a foreign-key violation that the user sees as an
untargeted 500. This spec makes the session layer verify the user still exists
and sign the ghost out instead.

## Problem / motivation

Observed 2026-09-10 against the production Docker stack. Creating a knowledge
base returned a 500; the browser console showed only the redacted Server
Components message, and the container log had the real cause:

```
insert or update on table "knowledge_bases" violates foreign key constraint
  "knowledge_bases_owner_id_users_id_fk"
detail: 'Key (owner_id)=(57508c24-8e1e-49b3-8d97-3042495d13e7) is not present in table "users".'
```

`select id, email from users` in that database returned **zero rows**, yet the
app considered the request authenticated. The cookie had been minted earlier
against the host Postgres used by `pnpm dev`; because `AUTH_SECRET` is shared
across both, the container's empty database accepted the cookie as valid.

The local trigger is mundane, but the failure mode is not — it is reachable in
any real deployment:

- **Account deletion.** Delete a user; every session they hold anywhere stays
  live until it expires, passing `src/proxy.ts` and every `requireUserId()`.
- **Backup restore.** Restoring a dump from before a user signed up (see
  [`0009`](0009-automated-backups.md)) leaves that user's live sessions
  pointing at a row that no longer exists.
- **Environment drift.** One `AUTH_SECRET` across two databases — exactly the
  dev/Docker split above — silently cross-authenticates.

The user-visible result is the worst kind of error: the app says you are signed
in as someone, then fails every write with a message that explains nothing and,
in production, is redacted to "an error occurred".

`src/lib/auth/index.ts` only ever reads the DB to _enrich_ the token
(`getUserRoles`, `getUserImage`), and `getUserRoles` returns `[]` for a missing
user — indistinguishable from a real user with no roles. Nothing in the chain
treats absence as a reason to distrust the token.

## Goals

- A session naming a non-existent user resolves as **signed out**, everywhere
  `getCurrentSession()` / `auth()` is used.
- The stale cookie is actively **cleared**, so the browser recovers on its own
  rather than looping through a broken authenticated state.
- No new database query on the hot path for ordinary signed-in requests.

## Non-goals

- Session revocation on demand (kicking a live user out on password change or
  an admin action). That needs a token version or a denylist — a separate spec.
- Moving off the JWT session strategy to database sessions.
- Changing `AUTH_SECRET` handling, or preventing one secret spanning two
  databases. This spec makes the consequence safe, not the configuration.

## Requirements

### Functional

- **FR1** — When the `jwt` callback resolves a token whose `id` has no row in
  `users`, the session is invalidated: `auth()` returns `null` and the session
  cookie is cleared.
- **FR2** — Existence is re-checked periodically, not once. A user deleted
  mid-session is signed out within `SESSION_REVALIDATE_SECONDS` rather than at
  token expiry.
- **FR3** — A token that has never been checked (issued before this change) is
  checked on its next use, so existing ghost cookies self-heal.
- **FR4** — Transient database failures during the check must **not** sign
  users out. An unreachable database is not proof a user was deleted.

### Non-functional

- **NFR1** — At most one extra `users` lookup per session per
  `SESSION_REVALIDATE_SECONDS` (default 300). Steady-state requests inside that
  window add no query.
- **NFR2** — The check runs only in the Node auth module. `src/lib/auth/config.ts`
  and `src/proxy.ts` stay edge-safe — no DB import.
- **NFR3** — The invalidation path must not throw; a ghost session ends in a
  clean signed-out state, never a 500.

## Design / approach

The whole fix lives in the Node `jwt` callback in `src/lib/auth/index.ts`.

**Returning `null` is the invalidation mechanism.** Confirmed against the
installed `@auth/core@0.41.2` source (`lib/actions/session.js`), not assumed:

```js
const token = await callbacks.jwt({ token: payload, ... })
if (token !== null) { /* build session, re-sign cookie */ }
else { response.cookies?.push(...sessionStore.clean()) }
```

So a `null` return gives both halves of the goal at once — a null session
(FR1) and a cleared cookie (FR2 of the browser's recovery). No other hook does
both.

**Throttling.** An unconditional lookup would add a `users` query to every
request that reads a session, which today is free for a signed-in user (roles
are on the token from sign-in; `getUserRoles` only runs when they are absent).
A `verifiedAt` claim on the token records the last successful check; the lookup
runs only when it is missing (FR3) or older than `SESSION_REVALIDATE_SECONDS`
(NFR1). The claim is written into the token, which `@auth/core` re-signs on
every session read, so it persists without extra machinery.

**Distinguishing "deleted" from "database down" (FR4).** The existence check
returns a tri-state rather than a boolean: `'present'`, `'missing'`, or
`'unknown'` when the query itself threw. Only `'missing'` invalidates.
`'unknown'` leaves `verifiedAt` untouched so the check is retried on the next
request, and the user stays signed in through a database blip. Getting this
backwards would turn a brief outage into a mass logout, so it is the one thing
a reviewer must not wave through.

**Why not fix it in `requireUserId()`.** That would patch one call site while
`src/lib/storage/actions.ts`, the document actions and every future action keep
the same hole, and it would leave the UI rendering as authenticated. The defect
is that the session is considered valid at all, so the session layer is where
it belongs.

## Acceptance criteria

- [x] A token whose `id` is absent from `users` makes the `jwt` callback return
      `null` — `tests/unit/auth-session-revalidation.test.ts`
- [x] A token whose user exists is returned unchanged, with `verifiedAt` set —
      `tests/unit/auth-session-revalidation.test.ts`
- [x] Inside the throttle window no `users` query is issued; past it, exactly
      one is — `tests/unit/auth-session-revalidation.test.ts`
- [x] A throwing `users` query leaves the session intact and `verifiedAt`
      unchanged — `tests/unit/auth-session-revalidation.test.ts`
- [x] End to end against the `docker-compose.prod.yml` stack (2026-09-10): a
      correctly-signed cookie for a user id absent from `users` returns
      `null` from `/api/auth/session`, is cleared via `Set-Cookie`, and is
      redirected `307 → /login` from `/chat`; a cookie for a seeded user still
      resolves to that user and renders `/chat` at `200`
- [x] Knowledge-base creation, the reported symptom, works against the same
      stack — `tests/e2e/knowledge-bases.spec.ts` (3/3 passing)

> **Not verified (2026-09-10).** The unit tests exercise `needsRevalidation`
> and `getUserPresence` directly and re-play the callback's decision sequence,
> but not the `jwt` callback function itself — importing
> `src/lib/auth/index.ts` pulls in NextAuth, every provider and argon2. The
> end-to-end criteria above cover the assembled path instead.

## Security & privacy

Strictly a tightening: sessions that are currently honoured stop being
honoured. The throttle means a deleted user keeps access for up to
`SESSION_REVALIDATE_SECONDS`; that is a deliberate trade against a per-request
query, and it is bounded and short. Anyone needing immediate revocation wants
the token-version mechanism listed under non-goals.

The check reads only `users.id` — no profile data is pulled into the token.

## Alternatives considered

- **Database session strategy.** Correct by construction (the session row dies
  with the user), but it puts a DB read on every request and abandons the
  edge-safe split that `src/proxy.ts` depends on. Far too large a change for
  this defect.
- **Per-request existence check, no throttle.** Simplest and strictest, but
  adds a query to every authenticated request purely to defend against a rare
  event. NFR1 exists to reject this.
- **Catch the FK violation in the actions.** Treats the symptom at one call
  site, leaves the ghost session live, and would have to be repeated in every
  action that writes an owned row.
- **Foreign key `ON DELETE CASCADE`.** Cleans up owned rows on deletion but
  does nothing about the session, and nothing at all for the restore and
  environment-drift cases where the row was never deleted.

## Out of scope / future

- Immediate revocation (token version / denylist) on password change or admin
  action.
- A user-facing account-deletion flow. There isn't one today; deletion is
  manual, which is part of why this went unnoticed.
- Making `requireUserId()` failures return `{ ok: false, error }` instead of
  throwing, so a signed-out Server Action shows a real message rather than a
  production-redacted one. Related but separable.

## References

- Reported 2026-09-10 from the `docker-compose.prod.yml` stack; container log
  quoted under **Problem** above.
- `@auth/core@0.41.2` — `lib/actions/session.js`, the `token !== null` branch.
- [`0028`](0028-independent-knowledge-bases.md) — the `knowledge_bases.owner_id`
  foreign key this surfaced through.
