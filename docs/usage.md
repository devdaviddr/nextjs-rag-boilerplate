# Usage & Development

[← Back to README](../README.md)

**What this covers:** getting the app running locally, then the day-to-day
reference you keep coming back to — every environment variable, every script,
how to test, how to run it in Docker, and what to check before you deploy.

Nothing here assumes you know how retrieval-augmented generation works.
The commands below get a working app on your machine; **[RAG — how it
works](rag.md)** is the page that explains what is actually happening when you
upload a PDF and ask a question. If you only want to look something up, jump
straight to [Environment variables](#environment-variables) or
[Scripts](#scripts).

## Requirements

- Node.js ≥ 20.9 (22 recommended)
- [pnpm](https://pnpm.io) — `corepack enable`
- Docker (for local Postgres + MinIO)

You also want an API key for an OpenAI-compatible inference endpoint if you
intend to use the document chat. A free [NVIDIA NIM](https://build.nvidia.com)
key works and is rate-limited rather than billed per token. Without one the app
still boots — `/chat` and `/documents` report themselves as unconfigured and
the RAG test suites self-skip — so you can evaluate everything else first.

## First run

Four steps from a fresh clone to a running app. Each one is safe to re-run.

```bash
# 1. Install dependencies
pnpm install

# 2. Configure the environment
cp .env.example .env
npx auth secret            # writes AUTH_SECRET into .env
# then set NVIDIA_API_KEY in .env

# 3. Start Postgres + MinIO, apply the schema, seed a demo user
pnpm docker:db
pnpm docker:minio
pnpm db:migrate
pnpm db:seed               # → demo@example.com / Password123

# 4. Run
pnpm dev                   # http://localhost:3000
```

`pnpm docker:db` starts a `pgvector/pgvector:pg17` container — Postgres with
the vector extension already compiled in, which is what the knowledge-base
tables need. `pnpm docker:minio` starts MinIO, the S3-compatible object store
that holds uploaded files, plus a one-shot container that creates the bucket.
`pnpm db:migrate` applies the committed migrations under `drizzle/`, and
`pnpm db:seed` inserts the demo user and the default roles.

Sign in with the seeded account, create a knowledge base, upload a PDF, and ask
it a question. [RAG → Setup](rag.md#setup) covers the model configuration in
detail, including how to point the app at a local Ollama or llama.cpp instead.

## Environment variables

Copy `.env.example` → `.env`. Every value is read through `src/lib/env.ts`,
which validates the whole environment with Zod when the module is first
imported — so a missing or malformed value fails fast at boot with a readable
error rather than surfacing as `undefined` deep inside a request.

A variable marked **required** has no default and the app will not start
without it. Everything else is optional and defaulted; the features they
control stay inert until you set them.

| Variable                     | Required | Notes                                                                                                                        |
| ---------------------------- | :------: | ---------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`               |    ✅    | Postgres connection string                                                                                                   |
| `S3_ENDPOINT`                |    ✅    | S3-compatible endpoint (MinIO by default)                                                                                    |
| `S3_ACCESS_KEY_ID`           |    ✅    | Matches `.env.example` / `docker-compose.yml` for local dev                                                                  |
| `S3_SECRET_ACCESS_KEY`       |    ✅    | Matches `.env.example` / `docker-compose.yml` for local dev                                                                  |
| `S3_BUCKET`                  |    ✅    | Bucket name — auto-created by `minio-init`                                                                                   |
| `S3_REGION`                  |    –     | Defaults to `us-east-1` (MinIO ignores region)                                                                               |
| `UPLOAD_MAX_SIZE_MB`         |    –     | Per-file size cap. Default `10`                                                                                              |
| `MAX_STORAGE_PER_USER_MB`    |    –     | Per-user quota. Default `500`                                                                                                |
| `UPLOAD_ALLOWED_MIME_TYPES`  |    –     | Comma-separated allow-list. Default images + PDF                                                                             |
| `AUTH_SECRET`                |    ✅    | `npx auth secret` — unique per environment, never reuse                                                                      |
| `AUTH_URL`                   |    –     | Canonical auth URL; set in production                                                                                        |
| `AUTH_TRUST_HOST`            |    –     | `true` behind a trusted proxy / in Docker                                                                                    |
| `AUTH_GITHUB_ID` / `_SECRET` |    –     | Enables GitHub sign-in when both set — see [OAuth](oauth.md)                                                                 |
| `AUTH_GOOGLE_ID` / `_SECRET` |    –     | Enables Google sign-in when both set — see [OAuth](oauth.md)                                                                 |
| `APP_URL`                    |    –     | Public origin for OG/`metadataBase`, `robots`/`sitemap`, and OAuth callback URLs. Default `http://localhost:3000`            |
| `NODE_ENV`                   |    –     | `development` \| `test` \| `production`                                                                                      |
| `LOG_LEVEL`                  |    –     | `debug` \| `info` \| `warn` \| `error`                                                                                       |
| `RATE_LIMIT_DISABLED`        |    –     | `true` to disable the in-memory auth rate limiter                                                                            |
| `EMAIL_ENABLED`              |    –     | `true` to turn on email; requires the SMTP vars below                                                                        |
| `EMAIL_FROM`                 |    †     | From address (required when `EMAIL_ENABLED=true`)                                                                            |
| `SMTP_HOST`                  |    †     | SMTP host (required when `EMAIL_ENABLED=true`)                                                                               |
| `SMTP_PORT`                  |    †     | SMTP port, e.g. `587` or `465` (required when enabled)                                                                       |
| `SMTP_USER`                  |    –     | SMTP username (if the server requires auth)                                                                                  |
| `SMTP_PASSWORD`              |    –     | SMTP password (if the server requires auth)                                                                                  |
| `SMTP_SECURE`                |    –     | `true` for implicit TLS; auto-true on port `465`                                                                             |
| `REQUIRE_EMAIL_VERIFICATION` |    –     | `true` soft-gates unverified users (only with email on) — see [Email](email.md)                                              |
| `VAPID_PUBLIC_KEY`           |    –     | Web Push — enabled only when all three VAPID vars are set                                                                    |
| `VAPID_PRIVATE_KEY`          |    –     | Web Push private key (server-only)                                                                                           |
| `VAPID_SUBJECT`              |    –     | Web Push contact URL, e.g. `mailto:you@example.com`                                                                          |
| `NVIDIA_API_KEY`             |    –     | Enables document chat. Free key from build.nvidia.com; ~40 requests/min. Unset: `/chat` reports unconfigured                 |
| `RAG_LLM_BASE_URL`           |    –     | Any OpenAI-compatible endpoint. Default `https://integrate.api.nvidia.com/v1`; point at Ollama/llama.cpp to go fully offline |
| `RAG_EMBED_MODEL`            |    –     | Default `nvidia/nemotron-3-embed-1b`. Must emit **2048** dimensions to match the `halfvec` column                            |
| `RAG_CHAT_MODEL`             |    –     | Writes the prose. Default `nvidia/nemotron-3-super-120b-a12b`                                                                |
| `RAG_PLANNER_MODEL`          |    –     | Plans and calls tools on the agentic path. Default `nvidia/nemotron-3.5-lightning-30b-a3b`                                   |
| `RAG_AGENTIC_ENABLED`        |    –     | `true` for the agentic retrieval loop. Default `false` — ~10× slower, better on follow-ups; see [RAG](rag.md)                |
| `RAG_*` (tuning)             |    –     | Chunking, retrieval floor, hybrid pool, loop budgets — all defaulted; the full table is in [RAG → Tuning](rag.md#tuning)     |

† Required only when `EMAIL_ENABLED=true`. Setting the toggle without a provider
fails fast at boot. SMTP is provider-agnostic — Resend, SendGrid, Mailgun, SES,
Postmark and Gmail all expose SMTP credentials. See [Email](email.md). S3 vars
are always required — see [Features → File uploads](features.md#file-uploads).

### Deployment-only variables

These are read by the deployment stacks rather than by the app's own config, so
they only matter once you leave your laptop. Each is documented in the page
that owns it.

| Variable                                                                                 | Consumed by                                                             | Docs                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| `BACKUP_RETENTION_DAYS`, `BACKUP_INTERVAL_SECONDS`                                       | the `db-backup` / `minio-backup` sidecars in `docker-compose.prod.yml`  | [Backups](backups.md)           |
| `OFFSITE_BACKUP_*`                                                                       | the optional offsite copy                                               | [Backups](backups.md)           |
| `CLOUDFLARE_TUNNEL_TOKEN`                                                                | the `cloudflared` daemon                                                | [Deployment](deployment.md)     |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `TUNNEL_HOSTNAME` | Terraform provisioning only (`make tunnel-provision`)                   | [Deployment](deployment.md)     |
| `APP_IMAGE`, `APP_TAG`                                                                   | `docker-compose.deploy.yml` / `make deploy`                             | [Self-hosting](self-hosting.md) |
| `APP_VERSION`, `APP_GIT_SHA`                                                             | baked into the image at build time; shown read-only in Settings → Build | [Self-hosting](self-hosting.md) |

## Scripts

Everything is a `pnpm` script. The ones you will use daily are `dev`, `test`
and the pre-push verify chain; the rest are here so you do not have to go
digging in `package.json`.

| Command                                                                 | Description                              |
| ----------------------------------------------------------------------- | ---------------------------------------- |
| `pnpm dev`                                                              | Start the dev server (Turbopack)         |
| `pnpm build` / `pnpm start`                                             | Production build / serve                 |
| `pnpm lint` · `pnpm lint:fix`                                           | ESLint                                   |
| `pnpm typecheck`                                                        | `tsc --noEmit`                           |
| `pnpm format` · `pnpm format:check`                                     | Prettier                                 |
| `pnpm test` · `pnpm test:watch` · `pnpm test:coverage`                  | Vitest units                             |
| `pnpm test:e2e` · `pnpm test:e2e:ui`                                    | Playwright E2E                           |
| `pnpm db:generate` · `db:migrate` · `db:push` · `db:studio` · `db:seed` | Database (see [Database](database.md))   |
| `pnpm rag:eval`                                                         | Retrieval evaluation (see [RAG](rag.md)) |
| `pnpm rag:eval --compare`                                               | Fixed pipeline vs agentic, side by side  |
| `pnpm rag:eval --label x --baseline y`                                  | Save a run; fail on a refusal regression |
| `pnpm rag:eval --no-ingest`                                             | Reuse what is already indexed            |
| `pnpm rag:corpus`                                                       | Rebuild the eval corpus PDFs             |
| `pnpm gen:icons` · `pnpm gen:og`                                        | Regenerate PWA icons · OG share image    |
| `pnpm docker:db`                                                        | Start the local Postgres container       |
| `pnpm docker:minio`                                                     | Start local MinIO + bucket init          |
| `pnpm docker:mail`                                                      | Start local Mailpit (email catcher)      |

Run this before every push. It is the whole quality gate — there is no CI
pipeline to catch what you miss:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Testing

Two suites. Unit tests are fast, need nothing running, and cover the logic that
is easy to get subtly wrong. End-to-end tests drive a real browser against a
real database, object store and mail catcher, and cover the flows a user
actually performs.

```bash
pnpm test            # unit tests (Vitest)
pnpm test:coverage   # units with coverage
pnpm test:e2e        # E2E (needs a migrated DB + running/built app)
```

- **Unit** tests live in `tests/unit/` — password hashing, validation schemas,
  upload validation, rate limiting, single-use tokens, RBAC, OAuth config, the
  email soft-gate guard, and Web Push send/prune. The `server-only` guard is
  stubbed for the test runner (see `vitest.config.ts`).
- **E2E** tests live in `tests/e2e/` — auth flows, protected-route redirects,
  RBAC, file upload/download/delete, avatars, PWA (manifest/SW/offline), SEO
  (robots/sitemap/OG), a11y (axe), the full email reset/verification
  round-trips against Mailpit (`email-flow.spec.ts`, self-skips if Mailpit is
  down), and the RAG product end to end — ingestion, citations, refusal,
  conversation history, and cross-knowledge-base isolation (`rag.spec.ts`,
  `chat.spec.ts`, `knowledge-bases.spec.ts`, self-skip without
  `NVIDIA_API_KEY`).
- **RAG unit** tests cover chunking, scope resolution, the router, the planner
  adapters, the bounded loop and its budgets, citation stripping, and the
  SQL-text assertions that both tenant and knowledge-base isolation are present
  in every retrieval channel.

Each test uses a unique client IP to isolate rate-limit buckets
(`tests/e2e/fixtures.ts`), and a `globalSetup` seeds the demo admin. Playwright
boots `pnpm dev` locally, and `pnpm start` when the `CI` environment
variable is set.

### Rate limits and the `--workers=1` rule

**With `RAG_AGENTIC_ENABLED=true`, run E2E with `--workers=1`.** Each agentic
question costs 5–8 upstream calls against a ~40/min ceiling, so parallel
workers measure contention with your own rate limiter, not the product. The
same applies to `pnpm rag:eval --compare` — never run two at once. [RAG](rag.md)
works through what each path costs per question.

Full green run against a live database, object store, and mail catcher:

```bash
pnpm docker:db && pnpm docker:minio && pnpm docker:mail && \
  pnpm db:migrate && pnpm build && pnpm test:e2e
```

## Docker

There are two ways to use Docker here. Day to day you only want the
dependencies — Postgres, MinIO, and a local mail catcher — with the app itself
running from `pnpm dev` so hot reload works:

```bash
pnpm docker:db          # docker compose up -d db
pnpm docker:minio       # docker compose up -d minio minio-init
pnpm docker:mail        # docker compose up -d mailpit
```

The second way runs the whole thing in containers, the way it runs in
production. Use it when you need to test the production build — thrown Server
Action errors are redacted in a production build but not under `next dev`, so
some bugs only appear here:

```bash
AUTH_SECRET=$(openssl rand -base64 33) \
  docker compose -f docker-compose.prod.yml up --build
```

That stack is seven services:

| Service        | Kind       | What it does                                                                                   |
| -------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `db`           | long-lived | `pgvector/pgvector:pg17` — Postgres with the vector extension, on the `pgdata` volume          |
| `migrate`      | one-shot   | Runs `pnpm db:migrate` once and exits; the app waits for it to complete                        |
| `minio`        | long-lived | S3-compatible object storage, on the `miniodata` volume. No published ports                    |
| `minio-init`   | one-shot   | Creates the app bucket, then exits. Idempotent, safe to re-run                                 |
| `db-backup`    | long-lived | Nightly compressed Postgres dumps into `./backups/postgres`, pruned to `BACKUP_RETENTION_DAYS` |
| `minio-backup` | long-lived | Mirrors the bucket into `./backups/minio` every `BACKUP_INTERVAL_SECONDS`                      |
| `app`          | long-lived | The Next.js app on port 3000, started only after `migrate` and `minio-init` succeed            |

The app image is a multi-stage build using Next.js `standalone` output, runs as
a non-root user, and exposes `/api/health` as a container healthcheck. MinIO
has no published ports in this stack — the app is the only public gateway to
it, which is why uploads and downloads are proxied through the app rather than
presigned.

One thing to know before you test document chat in that stack: the compose
files set the database and storage variables inline on the `app` service and do
**not** pass `NVIDIA_API_KEY` or the `RAG_*` variables through. Add them to the
`app` service's `environment:` block if you want the chat configured there. See
[Backups](backups.md) for the backup sidecars and
[Self-hosting](self-hosting.md) for the deploy stacks.

## Git hooks

Husky installs a `pre-commit` hook that runs **lint-staged** (ESLint + Prettier
on staged files), and a `commit-msg` hook that enforces Conventional Commits.
They are wired up by the `prepare` script on `pnpm install`. To bypass in an
emergency: `git commit --no-verify`.

## Continuous integration

There is no CI pipeline. `ci.yml` was removed deliberately; the quality gate is
the pre-commit hook plus the checklist below, run locally before a push:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The one workflow that remains, `.github/workflows/deploy.yml`, is an opt-in
self-hosted deploy triggered by a `v*` tag — and it is gated behind the repo
variable `SELF_HOSTED_DEPLOY`, which is `false`. With no image-publishing job
left, a release tag currently ships nothing; restore a build/push job before
enabling it. [CI/CD](ci-cd.md) keeps the full record of what the pipeline used
to do, and [Deployment](deployment.md) covers how deploys work now.

## Extending

Common changes and where to make them. Anything touching the database schema
follows the migration workflow in [Database](database.md) — edit the schema,
generate the migration, review it, commit it, apply it.

| Task                        | How                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Add a protected route       | Create a page under `src/app/(dashboard)/`, add its prefix to `PROTECTED_PREFIXES` in `src/proxy.ts`                           |
| Add a sidebar link          | Add `{ title, href, icon }` to `src/lib/shell/nav.ts`                                                                          |
| Add a table                 | Edit `src/db/schema.ts`, then `pnpm db:generate && pnpm db:migrate`                                                            |
| Add a shadcn component      | `pnpm dlx shadcn@latest add <name>`                                                                                            |
| Add an OAuth provider       | GitHub + Google ship; add another in `src/lib/auth/index.ts` with its `AUTH_<PROVIDER>_*` env vars — see [OAuth](oauth.md)     |
| Gate a route by role        | Add a prefix → roles entry to `ROLE_REQUIRED` in `src/proxy.ts`; assert `requireRole('admin')` in the action                   |
| Add a role                  | Insert into the `roles` table (see `src/db/seed.ts`); assign via the Settings admin panel or `assignRoles`                     |
| Enable email                | Set `EMAIL_ENABLED=true` + the `SMTP_*` vars in `.env`; templates live in `src/lib/email/templates.ts`                         |
| Change upload limits        | Adjust `UPLOAD_MAX_SIZE_MB` / `MAX_STORAGE_PER_USER_MB` / `UPLOAD_ALLOWED_MIME_TYPES` in `.env`                                |
| Point storage at real S3/R2 | Set `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_BUCKET` — `src/lib/storage/client.ts` is unmodified either way |
| Add an env var              | Add it to the schema in `src/lib/env.ts` and to `.env.example`                                                                 |
| Turn on agentic retrieval   | `RAG_AGENTIC_ENABLED=true` in `.env`, restart. Run `pnpm rag:eval --compare` on your corpus first — see [RAG](rag.md)          |
| Go fully offline            | Point `RAG_LLM_BASE_URL` at Ollama/llama.cpp; the embedding model must emit 2048 dims, the planner must emit native tool calls |
| Tune the agentic loop       | `RAG_MAX_SEARCHES` / `RAG_MAX_LOOP_MS` / `RAG_MAX_LOOP_TOKENS` / `RAG_AGENTIC_FLOOR_STEP` — [RAG → Tuning](rag.md#tuning)      |

## Production checklist

Work through this before the app faces real users. Most items are one line in
`.env`; the ones that are not are called out.

- [ ] Unique, strong `AUTH_SECRET` per environment.
- [ ] `DATABASE_URL` on managed Postgres with TLS (`sslmode=require`).
- [ ] Change the default `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` from
      `minioadmin`/`minioadmin` (fine for a MinIO instance with no public
      ingress, but don't leave the default if you ever expose it directly).
- [ ] Run `pnpm db:migrate` as a deploy step.
- [ ] Terminate TLS at a trusted proxy; set `AUTH_TRUST_HOST=true`.
- [ ] Swap the in-memory rate limiter for a shared store (e.g. Upstash) if you
      run more than one instance.
- [ ] Wire error tracking (Sentry) — a structured-logging shim (`src/lib/logger.ts`)
      is already in place.
- [ ] Serve over HTTPS so the service worker registers and the app is installable.
- [ ] Replace placeholder icons (`pnpm gen:icons`) and set the manifest name/colors.
- [ ] If using email, set `EMAIL_ENABLED=true` with valid `SMTP_*` credentials and a
      deliverable `EMAIL_FROM` (SPF/DKIM aligned) — leave it off to keep sends inert.
- [ ] Seed or assign an initial `admin` role so the Settings user-management panel is reachable.
- [ ] If document chat is enabled, run `pnpm rag:eval` against your own corpus
      and save it as a baseline, so a later retrieval change can be scored
      rather than argued about — see [RAG](rag.md).

---

**Next:** [RAG — how it works](rag.md) explains what happens between uploading
a PDF and getting a cited answer, and [Database](database.md) covers the schema
and the migration workflow.
