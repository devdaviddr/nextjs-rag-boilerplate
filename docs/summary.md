# Summary

[← Back to README](../README.md)

**What this covers:** the whole project on one page — what it is, what it is
built from, and what already works — with links to the page that explains each
part properly.

A production-ready Next.js 16 template for **grounded document chat**. Users
register, upload PDFs into private knowledge bases they own, and hold
conversations answered only from those documents, with a page-level citation
for every claim. Authentication, PostgreSQL + pgvector, object storage, a PWA,
Docker and a retrieval evaluation harness are already wired together and
tested, so day one is spent on your features rather than on plumbing.

If you have never built a retrieval-augmented generation system, start with the
**[Tutorial](tutorial.md)**, which builds one with this repo in front of you.
**[RAG — how it works](rag.md)** is the reference behind it, and defines every
term from scratch.

## Quick stats

- **Version:** 0.20.0
- **License:** MIT
- **Type:** Full-stack Next.js 16 application template (not a library)
- **Target:** Single-box production (Docker + Cloudflare Tunnel)

## Core Tech Stack

| Layer            | Technology        | Version               |
| ---------------- | ----------------- | --------------------- |
| Framework        | Next.js           | 16.2.10               |
| Runtime          | React             | 19.2.7                |
| Language         | TypeScript        | 5.9.3                 |
| Database         | PostgreSQL        | 17 (+ pgvector)       |
| ORM              | Drizzle           | 0.45.2                |
| Auth             | Auth.js v5        | 5.0.0-beta.31         |
| Password Hashing | Argon2id          | @node-rs/argon2 2.0.2 |
| UI               | Tailwind CSS      | v4 + shadcn/ui        |
| Storage          | S3-compatible     | MinIO (or R2/S3)      |
| PDF text         | unpdf             | in-process extraction |
| Models           | OpenAI-compatible | NVIDIA NIM by default |
| PWA              | Service Worker    | Hand-rolled           |

Turbopack builds both `dev` and `build`, which is why the service worker is
hand-rolled rather than generated. Architectural detail:
**[Architecture](architecture.md)**.

## What ships out of the box

Each line links to the page that explains it. The full inventory is in
**[Features](features.md)**.

**Document chat (RAG)** — multiple independent knowledge bases per user, PDF
upload and ingestion, hybrid retrieval (dense `pgvector` HNSW + lexical
`tsvector` GIN, fused with Reciprocal Rank Fusion), page-level citations,
grounded-or-refuse answering, an optional agentic retrieval loop
(`RAG_AGENTIC_ENABLED`, off by default), and an evaluation harness
(`pnpm rag:eval`) reporting hit@k, MRR, refusal accuracy and
cross-knowledge-base leakage. → **[RAG](rag.md)**

**Authentication** — email + password with Argon2id, stateless JWT sessions,
GitHub and Google OAuth (opt-in), RBAC with `admin` / `member` / `viewer`
roles, invite-based passwordless account claim, password reset and email
verification (opt-in). → **[Features](features.md)** ·
**[OAuth](oauth.md)** · **[Email](email.md)**

**Security** — rate limiting on auth endpoints (per-account plus a global
per-IP login cap), a per-request CSP nonce, HSTS and security headers,
edge-protected routes re-checked server-side, user-enumeration resistance, and
environment validation that fails fast at boot. →
**[Architecture → Security model](architecture.md#security-model)**

**Database** — PostgreSQL 17 with Drizzle ORM, a type-safe schema with
generated migrations, dedicated tables for auth, files, push, roles, documents
and conversations, and an idempotent seed script. →
**[Database](database.md)**

**File storage** — MinIO or any S3-compatible store, per-user quotas,
ownership-checked downloads, MIME-type and size validation, profile photos. →
**[Features → File uploads](features.md#file-uploads)**

**Progressive Web App** — installable, hand-rolled service worker, offline
fallback page, responsive app shell, light/dark theme, and Web Push via VAPID.
→ **[PWA & App Shell](pwa.md)** · **[Web Push](push.md)**

**Developer experience** — strict TypeScript, ESLint + Prettier + Husky hooks,
Vitest unit tests and Playwright E2E, Docker for local Postgres, MinIO and
Mailpit. → **[Usage & Development](usage.md)**

**Deployment** — a one-command self-hosting wizard (`make setup`), Cloudflare
Tunnel so there are no open ports and no certificates, a multi-stage Dockerfile
with a non-root runtime, pull-based continuous deployment from a published
image (`make deploy`), macOS boot persistence for an always-on Mac mini
(`make autostart`), and automated Postgres + MinIO backups. →
**[Self-hosting](self-hosting.md)** · **[Deployment](deployment.md)** ·
**[Backups](backups.md)**

> **No CI in this fork.** The `CI` and `CodeQL` GitHub Actions workflows were
> deleted; only `deploy.yml` remains, and it only runs when the repository
> variable `SELF_HOSTED_DEPLOY` is `'true'`. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
> yourself before pushing. The record of what the pipeline did is kept in
> **[CI/CD](ci-cd.md)**.

## Where to start

| If you want to…                            | Read                            |
| ------------------------------------------ | ------------------------------- |
| Learn RAG by building it up                | [Tutorial](tutorial.md)         |
| Get it running locally                     | [Usage & Development](usage.md) |
| Understand retrieval from first principles | [RAG — how it works](rag.md)    |
| See the tables and the ERD                 | [Database](database.md)         |
| See what talks to what                     | [Architecture](architecture.md) |
| Put it on the internet                     | [Self-hosting](self-hosting.md) |

**Next:** [Tutorial](tutorial.md) if RAG is new to you, otherwise
[Usage & Development](usage.md) — the scripts, the environment variables and the
local Docker workflow.
