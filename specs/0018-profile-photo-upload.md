---
id: 0018
title: Profile photo upload
status: Shipped
release: 'v0.7.0'
created: 2026-07-13
updated: 2026-07-13
---

# 0018 — Profile photo upload

## Summary

Let a signed-in user upload, replace, and remove a custom profile photo,
built entirely on the file-storage infrastructure already shipped in
[spec 0007](0007-file-uploads.md) (MinIO, the `files` table, ownership-checked
downloads). The photo is surfaced through Auth.js's standard `user.image`
field, so it "just works" wherever a session is already read — no new
display plumbing beyond the app shell and Settings.

## Problem / motivation

Spec 0007 shipped general file storage but nothing uses it for the most
common small file a user uploads: their own avatar. `users.image` already
exists (Auth.js Drizzle-adapter convention, currently always `null` for
credentials users) and is already typed on the session
(`DefaultSession['user']` includes `image` — no type augmentation needed) —
it's wired up and simply unused.

## Goals

- Upload/replace a profile photo from Settings; see it update immediately,
  no re-login required.
- Remove a photo, reverting to a fallback (initials/icon).
- The photo shows in the app shell topbar and Settings, anywhere the session
  is already read.
- Reuses spec 0007's storage, ownership, and quota machinery — no parallel
  storage path.

## Non-goals

- Showing other users' avatars anywhere (admin user table, future public
  profile pages) — today only the owner can fetch their own photo via the
  existing owner-only `GET /api/files/[id]`. Widening that is a follow-up if
  a page ever needs to render someone else's avatar.
- Image cropping/resizing — the uploaded file is stored as-is; the UI just
  constrains display size via CSS.
- OAuth-provided avatars (spec 0010, if it ships) — those already populate
  `users.image` directly from the provider; this spec's upload path simply
  becomes the credentials-user equivalent of the same field.

## Requirements

### Functional

- **FR1** — `users` gains a nullable `avatar_file_id` column, FK →
  `files.id` (`onDelete: 'set null'`) — the operational pointer to "which
  `files` row is the current avatar," so replacing one is an explicit,
  atomic swap rather than string-parsing `users.image`.
- **FR2** — `uploadProfilePhoto(formData)` Server Action: validates
  (image-only MIME allow-list, its own smaller size cap), uploads the new
  object first, then updates `users.avatar_file_id` + `users.image` (to
  `/api/files/{id}`), then deletes the previous avatar's object + row if one
  existed — in that order, so a failed upload never leaves a user with no
  photo.
- **FR3** — `removeProfilePhoto()` Server Action: clears `avatar_file_id` +
  `image`, deletes the previous object + row.
- **FR4** — An avatar control in Settings' `CurrentUserCard` — circular
  preview (fallback initials/icon when unset), upload, and remove.
- **FR5** — The app shell topbar shows the same avatar next to the user's
  email (`AppShell`'s `user` prop gains `image`, threaded from
  `session.user.image` in the dashboard layout).
- **FR6** — After upload/remove, the client calls `next-auth/react`'s
  `update()` so the JWT/session refresh immediately — no sign-out/in needed
  to see the change. The `jwt` callback in `src/lib/auth/index.ts` already
  has a `trigger === 'update'` branch (added for RBAC self-healing); extend
  it to also refetch `image` from the DB, alongside the existing roles
  refetch.

### Non-functional

- **NFR1** — Avatar uploads are validated and rate-limited through the same
  path as spec 0007's general uploads (`src/lib/storage/validation.ts`,
  `src/lib/rate-limit.ts`) — no separate/weaker validation path.
- **NFR2** — Avatar storage counts against the same per-user
  `MAX_STORAGE_PER_USER_MB` quota as any other uploaded file — no special
  carve-out that could be used to bypass it.
- **NFR3** — Zero behavior change for OAuth-provided avatars (spec 0010, if
  shipped): `users.image` is a plain column either flow can set; this spec
  doesn't special-case who last wrote it.

## Design / approach

- **Validation** — `validateUpload()` (spec 0007) is generalized to accept
  optional overrides (`maxSizeBytes`, `allowedMimeTypes`), defaulting to the
  existing env-driven values; avatar uploads pass their own constants
  (`image/png`, `image/jpeg`, `image/webp`; a smaller fixed cap, e.g. 5 MB)
  without adding new env vars — this is narrow enough not to need
  operator-tunable config. The shared per-user quota check is unaffected
  (it's the same `currentUsageBytes()` regardless of which caller validates).
- **Swap ordering** — new object uploaded and the DB row swapped to point at
  it _before_ the old object is deleted, mirroring the "create new, then
  clean up old" ordering already used for admin user deletion in spec 0007.
- **Serving** — reuses `GET /api/files/[id]` unchanged. Since it's
  owner-only, `<img src={session.user.image}>` only ever resolves for the
  signed-in owner viewing their own photo — consistent with the Non-goals.
- **Freshness** — `next-auth/react`'s `update()` triggers the `jwt`
  callback with `trigger === 'update'`; the existing branch there
  (`src/lib/auth/index.ts`) that refetches roles on update gets a sibling
  fetch for the user's current `image` column, so both self-heal on the same
  trigger rather than adding a second update mechanism.
- **Edge config unaffected** — `src/lib/auth/config.ts` (edge-safe, used only
  by `proxy.ts` for route/role checks) needs no changes; it never mints
  tokens, only reads them.

## Acceptance criteria

- [x] Uploading a photo in Settings updates the avatar shown there and in
      the app shell topbar without a page reload or re-login — required
      fixing a real bug: `useSession().update()` called with no argument is
      just a GET re-fetch and never reruns the `jwt` callback's
      `trigger === 'update'` branch; `update({})` does. E2E-verified.
- [x] Uploading a second photo replaces the first — exactly one avatar
      object exists in MinIO per user afterward (the old one is deleted) —
      E2E-verified (the old object's URL 404s after the swap).
- [x] Removing a photo clears it everywhere it's displayed and deletes the
      stored object — E2E-verified.
- [x] An oversized or non-image file is rejected with a clear inline error,
      verified against the actual production Docker build, not just
      `next dev` (spec 0007 found that thrown Server Action errors are
      redacted in production; this reuses the `{ ok, error }` return
      pattern, not `throw`).
- [x] Avatar storage counts toward the user's existing per-user quota —
      unit-tested (shared `validateUpload` quota check, avatar-specific
      size/type overrides).
- [x] Deleting a user (admin action) also deletes their avatar object —
      E2E-verified end to end (admin deletes a user with an avatar; its old
      URL 404s afterward), not just assumed from the existing
      `deleteAllFilesForUser` wiring.
- [x] A real accessibility regression was caught and fixed along the way:
      the new `AvatarFallback` (`bg-muted text-muted-foreground`, shadcn's
      default) failed WCAG AA contrast (4.34:1, needs 4.5:1) at small sizes
      — caught by the existing `tests/e2e/a11y.spec.ts` suite, fixed by
      switching to `text-foreground`.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`
      pass.

## Security & privacy

- No new exposure: the avatar reuses the existing owner-only download route
  and the existing per-user storage quota; no public/unauthenticated access
  is introduced.
- `avatar_file_id`'s `onDelete: 'set null'` means a `files` row can never be
  deleted while a dangling `users.avatar_file_id` points at it silently —
  the reference clears instead of pointing at nothing.

## Alternatives considered

- **Store the avatar as a separate, non-`files` blob column or table** —
  rejected; it would duplicate storage, quota, and cleanup logic that spec
  0007 already built and tested.
- **Parse the `files.id` out of `users.image`'s URL instead of a dedicated
  FK column** — works but is fragile (couples the swap logic to a URL
  string format) for no real savings over one small nullable column.

## Out of scope / future

- Public/shared avatar visibility (profile pages, admin table thumbnails).
- Image cropping/resizing on upload.

## References

- [README](../README.md).
- Builds directly on [0007 — File uploads](0007-file-uploads.md) (storage
  client, validation, quota, ownership pattern) and its production-redaction
  fix (`{ ok, error }` return pattern).
- `users.image` / Auth.js Drizzle-adapter convention, present since
  [0001](0001-project-foundation.md).
