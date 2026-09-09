---
id: 0001
title: Project foundation
status: Shipped
release: 'v0.1.0'
created: 2026-07-11
updated: 2026-07-12
---

# 0001 — Project foundation

## Summary

Establish a production-grade, batteries-included Next.js 16 boilerplate with
authentication, a database, containerisation, and CI already wired and tested,
so feature work can start immediately rather than after days of setup.

## Problem / motivation

Starting a full-stack app repeatedly re-solves the same problems (auth, DB,
migrations, Docker, CI, testing, linting) — usually inconsistently and
half-tested. A vetted, opinionated foundation removes that tax.

## Goals

- Working email + password auth out of the box.
- Type-safe database access with committed migrations.
- One-command local dev and a deployable container.
- Green CI covering lint, types, unit, and E2E.

## Non-goals

- OAuth / social login, email verification, password reset (later specs).
- Multi-tenancy, RBAC, billing.

## Requirements

### Functional

- **FR1** — Register, log in, log out; a protected `/dashboard`.
- **FR2** — Sessions persist across requests and expire.
- **FR3** — Schema changes flow through generated, committed migrations.

### Non-functional

- **NFR1** — Passwords hashed with Argon2id; no plaintext.
- **NFR2** — Strict TypeScript; lint/format enforced.
- **NFR3** — Environment validated at boot (fail fast).
- **NFR4** — Container runs as non-root with a health probe.

## Design / approach

- **Next.js 16** App Router (RSC + Server Actions), Turbopack for dev and build.
- **Auth.js v5** Credentials provider with an edge/node split: an edge-safe
  `config.ts` vs the Node `index.ts` (argon2 + DB); route protection in
  `src/proxy.ts`. JWT session strategy.
- **Drizzle ORM** + PostgreSQL via `postgres-js`; migrations in `drizzle/`.
- **Zod-validated env** (`src/lib/env.ts`).
- **Tailwind v4 + shadcn/ui**; **Vitest** + **Playwright** tests.
- **Multi-stage Docker** (standalone output, non-root) + `docker-compose` (app,
  db, one-shot migrator) + **GitHub Actions** CI.

## Acceptance criteria

- [x] Register → dashboard → sign out → sign in works end-to-end (E2E).
- [x] Unauthenticated access to `/dashboard` redirects to `/login`.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass.
- [x] Production image builds, runs non-root, and serves `/api/health`.

## Security & privacy

- Argon2id hashing; user-enumeration-resistant login (dummy verify on miss).
- HTTP-only encrypted JWT cookies; hardened response headers.
- Secrets git/docker-ignored; env validated at boot.

## Alternatives considered

- **Prisma** instead of Drizzle — heavier runtime; Drizzle is SQL-first and
  edge-friendly.
- **NextAuth database sessions** — unnecessary for a credentials app; JWT avoids
  a per-request DB round-trip.

## Out of scope / future

- OAuth, email verification, password reset, RBAC, observability.

## References

- Release: `v0.1.0`.
- Docs: [`docs/architecture.md`](../docs/architecture.md),
  [`docs/database.md`](../docs/database.md).
