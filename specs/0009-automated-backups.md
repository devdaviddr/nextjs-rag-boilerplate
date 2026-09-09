---
id: 0009
title: Automated backups (Postgres + MinIO)
status: Shipped
release: 'v0.13.0'
created: 2026-07-13
updated: 2026-07-13
---

# 0009 — Automated backups (Postgres + MinIO)

## Summary

Add scheduled, retained backups of both the Postgres database and the MinIO
object store to the production `docker-compose` stack, with a documented
restore runbook and an automated doctor script that confirms a recent backup
actually exists. A self-hosted single box has no managed-service safety net —
a disk failure without this is total data loss.

## Problem / motivation

Every other piece of state in this boilerplate (auth, RBAC, files once
[0007](0007-file-uploads.md) ships) lives in one Postgres instance and one
MinIO volume on one physical machine. There is currently no backup mechanism
at all. For a POC this may be tolerable; for anything the owner actually cares
about losing, it isn't.

## Goals

- Nightly Postgres dump, retained on a rolling window, with zero custom cron
  code where a maintained image already does this well.
- Periodic MinIO object sync to a local backup path, with the same retention
  approach.
- A documented, tested restore path for both.
- An automated check that the latest backup is recent (not just that a backup
  job exists — that it's actually succeeding).

## Non-goals

- Point-in-time recovery (WAL archiving) — nightly dumps are the right
  fidelity for a portfolio/POC app; PITR is a follow-up for apps that need it.
- Mandatory offsite backup — documented as an optional, explicitly-configured
  add-on (see Design), not a forced cloud dependency.
- Backup encryption at rest beyond what the filesystem/volume already
  provides (documented as a caveat, not solved here).

## Requirements

### Functional

- **FR1** — A `db-backup` service in `docker-compose.prod.yml` running
  `pg_dump` on a nightly schedule against the `db` service, writing timestamped,
  compressed dumps to a bind-mounted `./backups/postgres/` directory, and
  pruning dumps older than `BACKUP_RETENTION_DAYS` (default 14).
- **FR2** — A `minio-backup` service performing `mc mirror` from the app
  bucket to `./backups/minio/` on the same schedule, similarly retained.
  Depends on [0007](0007-file-uploads.md) — only relevant once MinIO exists.
- **FR3** — `docs/backups.md`: step-by-step restore for both Postgres
  (`pg_restore`/`psql < dump.sql`) and MinIO (`mc mirror <backup> minio/bucket`),
  written and actually exercised once against a scratch stack before this spec
  ships.
- **FR4** — `scripts/backup-verify.sh` (mirrors the existing
  `scripts/tunnel-verify.sh` doctor pattern): fails if the newest Postgres dump
  is older than 25 hours, non-empty check on the file.
- **FR5** — A documented, optional offsite step: `mc mirror` (or `rclone`) to
  a Cloudflare R2 bucket, off by default, enabled by setting
  `OFFSITE_BACKUP_*` env vars — not required for the default single-box setup.

### Non-functional

- **NFR1** — Backup jobs run inside the existing Docker Compose network; no
  new public ingress.
- **NFR2** — Backup failures are logged loudly (container exit code /
  restart policy visible in `docker compose ps`) rather than failing silently.
- **NFR3** — Restoring must not require re-deriving undocumented tribal
  knowledge — the runbook is the source of truth, tested, not aspirational.

## Design / approach

- **Postgres** — use a maintained, purpose-built image
  (`prodrigestivill/postgres-backup-local` or equivalent — evaluate current
  best-maintained option at implementation time) rather than hand-rolling a
  cron+`pg_dump` script. This is the "industry standard middle ground": a
  battle-tested image with configurable schedule/retention, zero app code.
- **MinIO** — no equivalently mature turnkey image exists; use the official
  `minio/mc` image with a small entrypoint script run on a cron schedule
  (`mc mirror --overwrite minio/bucket /backups`), following the same
  one-shot/sidecar container pattern already used for `migrate` and (per
  [0007](0007-file-uploads.md)) `minio-init`.
- **Storage** — backups land on a bind-mounted host directory
  (`./backups/`), so they survive container recreation but explicitly **not**
  disk failure — call this out clearly in `docs/backups.md` so it isn't
  mistaken for a complete strategy. Offsite copy (FR5) is the documented
  answer for anyone who needs disk-failure resilience, opt-in given it
  reintroduces a cloud dependency.
- **Verification** — `backup-verify.sh` is intentionally cheap (file
  existence + mtime + non-zero size), not a full restore-and-diff — a full
  restore drill is a manual runbook step, not automated CI, since it needs a
  disposable Postgres/MinIO instance.

## Acceptance criteria

- [x] The `db-backup` service produces a compressed Postgres dump in
      `./backups/postgres/` — verified by running the real
      `prodrigestivill/postgres-backup-local:17` image once against the dev DB;
      it wrote `daily/app-*.sql.gz` (and last/weekly/monthly copies).
- [x] Dumps past retention are pruned — handled by the image's
      `BACKUP_KEEP_DAYS` (`BACKUP_RETENTION_DAYS`, default 14); its
      "Cleaning older files" step ran.
- [x] `./scripts/backup-verify.sh` exits **1** with no recent backup and **0**
      with a fresh one — both states verified.
- [x] Restoring a dump into a scratch database via the runbook produced a
      working schema **with data** (327 users, 3 roles) — actually exercised,
      not just written.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass. Infra-only:
      no app code changed. Offsite config lives in `.env.example` + the runbook
      rather than `env.ts`, since the Next app never consumes those vars (the
      backup sidecars do) — adding them to the app's Zod schema would be
      misleading.

Verification notes:

- The Postgres backup image, the doctor script (both exit states), and a full
  dump→restore-into-scratch-DB→data-present cycle were all exercised locally
  against the running dev database. The MinIO mirror sidecar and the full
  scheduled `docker compose -f docker-compose.prod.yml up` (which also builds
  the app image) were validated structurally via `docker compose config`; a
  live scheduled run on a real deploy is a deployment-time check, not CI.

## Security & privacy

- Backup files contain full user data (emails, password hashes, file
  contents) — `./backups/` must be excluded from anything world-readable and
  is already covered by `.dockerignore`/`.gitignore` patterns; document that
  the host directory permissions matter.
- Offsite credentials (if FR5 is enabled) are scoped, least-privilege API
  tokens, following the same posture as the Cloudflare Tunnel provisioning
  token in [0005](0005-cloudflare-tunnel-deployment.md).

## Alternatives considered

- **WAL-based continuous backup (e.g. `pgBackRest`, `wal-g`)** — much
  stronger RPO, but real operational weight (WAL archiving config, restore
  complexity) that doesn't match "mid-range, not too much" for a portfolio
  app. Documented as a future option for apps with real durability needs.
- **Managed backup service (e.g. a paid cloud backup product)** — reintroduces
  the cloud dependency this whole roadmap avoids for the default path.
- **Hand-rolled cron + `pg_dump` script instead of a maintained image** —
  more code to maintain for no benefit over an existing, well-tested image.

## Out of scope / future

- Point-in-time recovery.
- Automated restore drills in CI.
- Backup encryption at rest.

## References

- [README](../README.md).
- Depends on: [0007](0007-file-uploads.md) for the MinIO half.
- Pattern reused from: [0005](0005-cloudflare-tunnel-deployment.md)'s
  `tunnel-verify` doctor script.
