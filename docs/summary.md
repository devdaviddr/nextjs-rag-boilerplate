# Summary

**What this covers:** the whole project on one page. It describes what the
project is, what it is built from and what already works, and links to the page
that explains each part properly.

This is a production-ready Next.js 16 template for grounded document chat.
Users register, upload PDFs into private knowledge bases they own, and hold
conversations answered only from those documents, with a page-level citation
for every claim. Authentication, PostgreSQL + pgvector, object storage, a PWA,
Docker and a retrieval evaluation harness are already wired together and
tested, so you can spend day one on your own features.

If you have never built a retrieval-augmented generation system, start with the
[Tutorial](tutorial.md), which builds one with this repo in front of you.
[RAG — how it works](rag.md) is the reference behind it and defines every term
from scratch.

## Quick stats

- Version: 0.24.1
- License: MIT
- Type: full-stack Next.js 16 application template (not a library)
- Target: single-box production (Docker + Cloudflare Tunnel)

## Core Tech Stack

| Layer            | Technology        | Version               |
| ---------------- | ----------------- | --------------------- |
| Framework        | Next.js           | 16.3.6                |
| Runtime          | React             | 19.2.7                |
| Language         | TypeScript        | 5.9.3                 |
| Database         | PostgreSQL        | 17 (+ pgvector)       |
| ORM              | Drizzle           | 0.45.2                |
| Auth             | Auth.js v5        | 5.0.0-beta.32         |
| Password Hashing | Argon2id          | @node-rs/argon2 2.0.2 |
| UI               | Tailwind CSS      | v4 + shadcn/ui        |
| Storage          | S3-compatible     | MinIO (or R2/S3)      |
| PDF text         | unpdf             | in-process extraction |
| Models           | OpenAI-compatible | NVIDIA NIM by default |
| PWA              | Service Worker    | Hand-rolled           |

Turbopack builds both `dev` and `build`, which is why the service worker is
hand-rolled instead of generated. For architectural detail, see
[Architecture](architecture.md).

## What ships out of the box

Each paragraph links to the page that explains it. The full inventory is in
[Features](features.md).

Document chat (RAG) supports multiple independent knowledge bases per user, PDF
upload and ingestion, and hybrid retrieval: dense `pgvector` HNSW and lexical
`tsvector` GIN, fused with Reciprocal Rank Fusion. Answers carry page-level
citations and are either grounded or refused. There is an optional agentic
retrieval loop (`RAG_AGENTIC_ENABLED`, on by default) and an evaluation
harness (`pnpm rag:eval`) that reports hit@k, MRR, refusal accuracy and
cross-knowledge-base leakage. See [RAG](rag.md).

Authentication covers email + password with Argon2id, stateless JWT sessions,
opt-in GitHub and Google OAuth, and RBAC with `admin` / `member` / `viewer`
roles. It also has invite-based passwordless account claim, plus opt-in
password reset and email verification. See [Features](features.md),
[OAuth](oauth.md) and [Email](email.md).

For security, auth endpoints are rate limited (per account, plus a global
per-IP login cap). Each request gets its own CSP nonce, HSTS and security
headers are set, and edge-protected routes are re-checked server-side. The app
resists user enumeration, and environment validation fails fast at boot. See
[Architecture → Security model](architecture.md#security-model).

The database is PostgreSQL 17 with Drizzle ORM: a type-safe schema with
generated migrations, dedicated tables for auth, files, push, roles, documents
and conversations, and an idempotent seed script. See
[Database](database.md).

File storage uses MinIO or any S3-compatible store, with per-user quotas,
ownership-checked downloads, MIME-type and size validation, and profile photos.
See [Features → File uploads](features.md#file-uploads).

The app is an installable Progressive Web App with a hand-rolled service
worker, an offline fallback page, a responsive app shell, a light/dark theme,
and Web Push via VAPID. See [PWA & App Shell](pwa.md) and
[Web Push](push.md).

For developers there is strict TypeScript, ESLint + Prettier + Husky hooks,
Vitest unit tests and Playwright E2E, and Docker for local Postgres, MinIO and
Mailpit. See [Usage & Development](usage.md).

Deployment starts with a one-command self-hosting wizard (`make setup`). A
Cloudflare Tunnel means no open ports and no certificates. The multi-stage
Dockerfile has a non-root runtime, continuous deployment is pull-based from a
published image (`make deploy`), and macOS boot persistence keeps an always-on
Mac mini running (`make autostart`). Postgres + MinIO backups are automated.
See [Self-hosting](self-hosting.md), [Deployment](deployment.md) and
[Backups](backups.md).

> GitHub Actions CI runs format, lint, typecheck, unit tests, `specs:check`
> and the Playwright suite on every PR. It publishes the app and migrate images
> to GHCR from `main`, and turns a `v*` tag into a release. See
> [CI/CD](ci-cd.md).

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
[Usage & Development](usage.md), which covers the scripts, the environment
variables and the local Docker workflow.
