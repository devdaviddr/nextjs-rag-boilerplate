---
id: 0007
title: File uploads & object storage (MinIO)
status: Shipped
release: v0.6.0
created: 2026-07-13
updated: 2026-07-13
---

# 0007 — File uploads & object storage (MinIO)

## Summary

Add file-upload capability backed by a self-hosted, S3-compatible object store
(**MinIO**) running as its own `docker-compose` service. The Next.js app is the
only public gateway — MinIO stays internal to the Docker network — so a POC or
portfolio app forked from this boilerplate can accept avatars, project
screenshots, resumes, or other assets without provisioning any cloud storage
account.

## Problem / motivation

Almost every POC or portfolio app needs to accept a file at some point (an
avatar, a project screenshot, a resume upload demo). Today there's nowhere to
put one: no object store, no upload endpoint, no size/type validation. Rolling
this per-project is exactly the kind of repeated setup this boilerplate exists
to eliminate.

## Goals

- A per-user file registry (list, download, delete) with ownership enforced
  server-side.
- Size and MIME-type validation before any bytes are persisted.
- A per-user storage quota, enforced at upload time.
- Zero additional public ingress — uploads/downloads flow through the existing
  Cloudflare Tunnel hostname, not a second exposed port.

## Non-goals

- Direct browser-to-MinIO presigned uploads (bypassing the Next.js server) —
  see Alternatives; deferred as a future optimization for higher-traffic
  deployments.
- Image transformation/resizing pipelines, virus scanning, or a CDN in front
  of objects.
- Public, unauthenticated file sharing (all files are owner-scoped by default).

## Requirements

### Functional

- **FR1** — A `minio` service in `docker-compose.yml` (dev) and
  `docker-compose.prod.yml` (prod), with a persisted volume and a healthcheck.
- **FR2** — A one-shot `minio-init` service (using the `minio/mc` image,
  mirroring the existing `migrate` one-shot pattern) that creates the app
  bucket and a least-privilege access policy on first boot.
- **FR3** — `uploadFile(formData)` Server Action: validates size
  (`UPLOAD_MAX_SIZE_MB`) and MIME type (`UPLOAD_ALLOWED_MIME_TYPES` allow-list)
  before streaming to MinIO via `PutObject`; rejects if the user's cumulative
  stored size would exceed `MAX_STORAGE_PER_USER_MB`.
- **FR4** — A `files` table (`id`, `ownerId` → `users.id`, `bucketKey`,
  `originalName`, `mimeType`, `sizeBytes`, `createdAt`) recording every stored
  object.
- **FR5** — `GET /api/files/[id]`: ownership-checked route handler that streams
  the object from MinIO back to the client (the only path a browser ever
  reaches MinIO through).
- **FR6** — `deleteFile(fileId)` Server Action: ownership check, then
  `DeleteObject` + row delete.
- **FR7** — `listMyFiles()` Server Action and a minimal "My Files" panel in
  Settings (list, download, delete) proving the flow end-to-end — not just
  scaffolded.

### Non-functional

- **NFR1** — MinIO is never reachable from outside the Docker network; the app
  is the sole public gateway, so no second Cloudflare Tunnel hostname is
  required per deployment.
- **NFR2** — Uploads are rate-limited per user (reuse `src/lib/rate-limit.ts`)
  and capped in size at the framework level, not just app-level validation.
- **NFR3** — `next.config.ts`'s Server Action body size limit is raised to
  match `UPLOAD_MAX_SIZE_MB` (default 1 MB is too small for any real upload).
- **NFR4** — Deleting a user (`admin-actions.ts` `deleteUser`) also deletes
  their files' DB rows and objects — no orphaned storage.

## Design / approach

- **Storage client** — `@aws-sdk/client-s3` (S3-compatible; works against
  MinIO unmodified) in a new `src/lib/storage/client.ts`, configured from
  `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` /
  `S3_BUCKET`, with `forcePathStyle: true` (required for MinIO). Guarded by
  `server-only`, same as `src/db`.
- **Upload path (server-proxied, not presigned-direct)** — the browser POSTs
  `multipart/form-data` to a Server Action, which validates then calls
  `PutObject`. This is simpler to operate than presigned direct-to-MinIO
  uploads (no second public hostname, no CORS config on MinIO) at the cost of
  routing bytes through the Node process — an acceptable trade-off given the
  size cap and the low concurrent traffic a self-hosted portfolio app expects.
  See Alternatives for the direct-upload path this deliberately defers.
- **Download path** — `GET /api/files/[id]` (Route Handler, not a Server
  Action, since it needs to stream a response with the right `Content-Type`)
  checks `requireOwnership` then pipes `GetObject`'s body through.
- **Bucket key layout** — `${ownerId}/${crypto.randomUUID()}-${sanitized(originalName)}`
  — namespaced per user, collision-free, and the random component prevents key
  guessing.
- **Quota check** — `SUM(files.sizeBytes) WHERE ownerId = ?` compared against
  `MAX_STORAGE_PER_USER_MB` before accepting a new upload; done in the same
  Server Action as the size/type check, before the `PutObject` call.
- **Env** — new required-when-used vars added to `src/lib/env.ts`'s Zod
  schema (`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `S3_BUCKET`, `UPLOAD_MAX_SIZE_MB` default `10`,
  `MAX_STORAGE_PER_USER_MB` default `500`,
  `UPLOAD_ALLOWED_MIME_TYPES` default a safe image/PDF allow-list) and
  `.env.example`.
- **Error handling** — `uploadFile`/`deleteFile` return `{ ok: true, data }`
  or `{ ok: false, error }` rather than throwing for expected/validation
  failures. Next.js redacts a thrown Error's `message` in production builds
  (a generic "an error occurred" reaches the client instead), which would
  have silently broken every user-facing validation message. This mirrors
  the `AuthFormState` return-value pattern `src/lib/auth/actions.ts` already
  uses for login/register — only genuinely unexpected failures (DB/S3 down)
  still throw, which is the correct case to redact.

## Acceptance criteria

- [x] `docker compose up` brings up `minio` healthy and `minio-init` creates
      the bucket exactly once (idempotent on restart) — verified against both
      `docker-compose.yml` and `docker-compose.prod.yml`.
- [x] Uploading a file over `UPLOAD_MAX_SIZE_MB` is rejected before any bytes
      reach MinIO — unit-tested (`validateUpload` runs before `putObject`).
- [x] Uploading a disallowed MIME type is rejected — E2E-verified.
- [x] A user who has hit `MAX_STORAGE_PER_USER_MB` cannot upload further files
      until they delete something — unit-tested.
- [x] `GET /api/files/[id]` for a file owned by another user returns 404, not
      the file — E2E-verified for both an anonymous request and a different
      signed-in user (the ownership check, not just an auth check).
- [x] Deleting a user cascades to their `files` rows and the underlying
      objects — E2E-verified end to end (admin deletes a user with an
      uploaded file; the file's download link 404s afterward).
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass; unit tests
      cover the validation/quota logic, E2E covers upload → list → download →
      delete, a rejected upload, cross-user access denial, and cascade delete.
- [x] Verified against the actual production Docker build, not just `next
dev` — this caught a real bug (Next.js redacts thrown Server Action
      error messages in production; fixed by returning `{ ok, error }`
      results instead of throwing for expected/validation failures).

## Security & privacy

- Ownership is checked server-side on every read/delete — never trust a
  client-supplied `ownerId`.
- MIME-type validation checks the declared `Content-Type` and is documented as
  best-effort (not a substitute for antivirus scanning, which is explicitly
  out of scope) — apps handling untrusted uploads at scale should layer that
  on top.
- MinIO root credentials and the S3 access key stay in `.env` only, never
  exposed to the client.
- Bucket keys include a random component so object URLs can't be enumerated.

## Alternatives considered

- **Presigned direct-to-MinIO uploads** — better for scale (bytes never touch
  the Node process), but requires MinIO to be publicly reachable (a second
  Cloudflare Tunnel hostname per deployment) and CORS configuration on the
  bucket. Deferred: not worth the operational overhead for a single-box,
  low-traffic deployment; documented as a future optimization.
- **Cloudflare R2 instead of self-hosted MinIO** — zero container to run, but
  requires a Cloudflare account/bucket per forked project and reintroduces a
  cloud dependency this roadmap deliberately avoids for the default path
  (matches the earlier decision to default to self-hosted MinIO).
- **Storing files in Postgres (bytea)** — simplest possible, no new service,
  but bloats the database and backup size; rejected for anything beyond
  trivial file sizes.

## Out of scope / future

- Presigned direct browser uploads (see Alternatives).
- Image resizing/thumbnailing, virus scanning, public share links.
- Multi-bucket / per-project storage isolation (single shared bucket is
  sufficient for one deployment = one app).

## References

- [README](../README.md).
- Depends on: none. [0009](0009-automated-backups.md) (backups) depends on
  this shipping first for the object-storage half of that spec.
