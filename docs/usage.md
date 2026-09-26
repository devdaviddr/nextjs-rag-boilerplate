# Usage & Development

**What this covers:** getting the app running locally, followed by the
reference you keep coming back to: every environment variable, every script,
how to test, how to run it in Docker, and what to check before you deploy.

Nothing here assumes you know how retrieval-augmented generation works.
The commands below get a working app on your machine, and [RAG — how it
works](rag.md) explains what actually happens when you upload a PDF and ask a
question. If you only want to look something up, jump straight to
[Environment variables](#environment-variables) or [Scripts](#scripts).

## Requirements

- Node.js ≥ 20.9 (22 recommended)
- [pnpm](https://pnpm.io), via `corepack enable`
- Docker (for local Postgres + MinIO)

To use the document chat you also need an API key for an OpenAI-compatible
inference endpoint. A free [NVIDIA NIM](https://build.nvidia.com) key works; it
is rate-limited instead of billed per token. The app still boots without one:
`/chat` and `/documents` report themselves as unconfigured and the RAG test
suites skip themselves, so you can evaluate everything else first.

## First run

A fresh clone takes four steps to reach a running app, and each one is safe to
re-run.

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

`pnpm docker:db` starts a `pgvector/pgvector:pg17` container, which is Postgres
with the vector extension already compiled in, as the knowledge-base tables
need. `pnpm docker:minio` starts MinIO, the S3-compatible object store that
holds uploaded files, plus a one-shot container that creates the bucket.
`pnpm db:migrate` applies the committed migrations under `drizzle/`, and
`pnpm db:seed` inserts the demo user and the default roles.

Sign in with the seeded account, create a knowledge base, upload a PDF, and ask
it a question. [RAG → Setup](rag.md#setup) covers the model configuration in
detail, including how to point the app at a local Ollama or llama.cpp instead.

## Environment variables

Copy `.env.example` → `.env`. Every value is read through `src/lib/env.ts`,
which validates the whole environment with Zod when the module is first
imported. A missing or malformed value therefore fails fast at boot with a
readable error, instead of surfacing as `undefined` deep inside a request.

The AI variables (`NVIDIA_API_KEY`, `RAG_LLM_BASE_URL` and every `RAG_*`) are
defined in `src/lib/ai-env.ts` and read through `aiSettings()` in
`src/lib/ai-settings`. A value saved from Settings takes precedence over the
variable, and without one the variable (or its default) applies, as before. Code
must not read `env.RAG_*` directly; `pnpm lint` fails if it does.

`SETTINGS_ENCRYPTION_KEY` (optional) encrypts API keys saved in Settings →
AI provider. Without it they are encrypted under a key derived from
`AUTH_SECRET`. Changing whichever is in use makes the saved keys unreadable, and
Settings asks for them again.

A variable marked required has no default, and the app will not start without
it. Everything else is optional and has a default, and the features those
variables control stay inert until you set them.

| Variable                           | Required | Notes                                                                                                                        |
| ---------------------------------- | :------: | ---------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                     |    ✅    | Postgres connection string                                                                                                   |
| `S3_ENDPOINT`                      |    ✅    | S3-compatible endpoint (MinIO by default)                                                                                    |
| `S3_ACCESS_KEY_ID`                 |    ✅    | Matches `.env.example` / `docker-compose.yml` for local dev                                                                  |
| `S3_SECRET_ACCESS_KEY`             |    ✅    | Matches `.env.example` / `docker-compose.yml` for local dev                                                                  |
| `S3_BUCKET`                        |    ✅    | Bucket name — auto-created by `minio-init`                                                                                   |
| `S3_REGION`                        |    –     | Defaults to `us-east-1` (MinIO ignores region)                                                                               |
| `UPLOAD_MAX_SIZE_MB`               |    –     | Per-file size cap. Default `10`                                                                                              |
| `MAX_STORAGE_PER_USER_MB`          |    –     | Per-user quota. Default `500`                                                                                                |
| `UPLOAD_ALLOWED_MIME_TYPES`        |    –     | Comma-separated allow-list. Default images + PDF                                                                             |
| `AUTH_SECRET`                      |    ✅    | `npx auth secret` — unique per environment, never reuse                                                                      |
| `AUTH_URL`                         |    –     | Canonical auth URL; set in production                                                                                        |
| `AUTH_TRUST_HOST`                  |    –     | `true` behind a trusted proxy / in Docker                                                                                    |
| `AUTH_GITHUB_ID` / `_SECRET`       |    –     | Enables GitHub sign-in when both set — see [OAuth](oauth.md)                                                                 |
| `AUTH_GOOGLE_ID` / `_SECRET`       |    –     | Enables Google sign-in when both set — see [OAuth](oauth.md)                                                                 |
| `APP_URL`                          |    –     | Public origin for OG/`metadataBase`, `robots`/`sitemap`, and OAuth callback URLs. Default `http://localhost:3000`            |
| `NODE_ENV`                         |    –     | `development` \| `test` \| `production`                                                                                      |
| `LOG_LEVEL`                        |    –     | `debug` \| `info` \| `warn` \| `error`                                                                                       |
| `LOG_PERSIST`                      |    –     | `false` stops keeping log lines in Postgres for Observability → Logs (stdout is unaffected). Default on                      |
| `LOG_RETENTION_DAYS`               |    –     | Days of log lines kept for Observability → Logs. Default `7`                                                                 |
| `TELEMETRY_RETENTION_DAYS`         |    –     | Days of runs (questions and ingestions, step by step) kept for Observability. Default `30`                                   |
| `RATE_LIMIT_DISABLED`              |    –     | `true` to disable the in-memory auth rate limiter                                                                            |
| `EMAIL_ENABLED`                    |    –     | `true` to turn on email; requires the SMTP vars below                                                                        |
| `EMAIL_FROM`                       |    †     | From address (required when `EMAIL_ENABLED=true`)                                                                            |
| `SMTP_HOST`                        |    †     | SMTP host (required when `EMAIL_ENABLED=true`)                                                                               |
| `SMTP_PORT`                        |    †     | SMTP port, e.g. `587` or `465` (required when enabled)                                                                       |
| `SMTP_USER`                        |    –     | SMTP username (if the server requires auth)                                                                                  |
| `SMTP_PASSWORD`                    |    –     | SMTP password (if the server requires auth)                                                                                  |
| `SMTP_SECURE`                      |    –     | `true` for implicit TLS; auto-true on port `465`                                                                             |
| `REQUIRE_EMAIL_VERIFICATION`       |    –     | `true` soft-gates unverified users (only with email on) — see [Email](email.md)                                              |
| `VAPID_PUBLIC_KEY`                 |    –     | Web Push — enabled only when all three VAPID vars are set                                                                    |
| `VAPID_PRIVATE_KEY`                |    –     | Web Push private key (server-only)                                                                                           |
| `VAPID_SUBJECT`                    |    –     | Web Push contact URL, e.g. `mailto:you@example.com`                                                                          |
| `NVIDIA_API_KEY`                   |    –     | Enables document chat. Free key from build.nvidia.com; ~40 requests/min. Unset: `/chat` reports unconfigured                 |
| `RAG_LLM_BASE_URL`                 |    –     | Any OpenAI-compatible endpoint. Default `https://integrate.api.nvidia.com/v1`; point at Ollama/llama.cpp to go fully offline |
| `RAG_EMBED_MODEL`                  |    –     | Default `nvidia/nemotron-3-embed-1b`. Must emit **2048** dimensions to match the `halfvec` column                            |
| `RAG_CHAT_MODEL`                   |    –     | Writes the prose. Default `nvidia/nemotron-3-super-120b-a12b`                                                                |
| `RAG_PLANNER_MODEL`                |    –     | Plans and calls tools on the agentic path. Default `nvidia/nemotron-3.5-lightning-30b-a3b`                                   |
| `RAG_PLANNER_REASONING`            |    –     | `off` skips the planner's hidden reasoning (faster decisions; Nemotron / Qwen3 on NIM or vLLM). Default `on`                 |
| `RAG_AGENTIC_ROUTE`                |    –     | `adaptive` plans only follow-ups and multi-part questions; `always` plans every question. Default `always`                   |
| `RAG_AGENTIC_CONFIDENT_SIMILARITY` |    –     | A first-search best match at or above this skips the planner's second decision. `1` (default) turns it off                   |
| `RAG_PLANNER_CALL_MS`              |    –     | Most any one planner call may take, in ms; `0` (default) means only `RAG_MAX_LOOP_MS` applies                                |
| `RAG_AGENTIC_ENABLED`              |    –     | `true` for the agentic retrieval loop. Default `false` — ~10× slower, better on follow-ups; see [RAG](rag.md)                |
| `RAG_*` (tuning)                   |    –     | Chunking, retrieval floor, hybrid pool, loop budgets — all defaulted; the full table is in [RAG → Tuning](rag.md#tuning)     |

† Required only when `EMAIL_ENABLED=true`. Setting the toggle without a provider
fails fast at boot. SMTP is provider-agnostic: Resend, SendGrid, Mailgun, SES,
Postmark and Gmail all expose SMTP credentials. See [Email](email.md). The S3
vars are always required; see [Features → File uploads](features.md#file-uploads).

### Deployment-only variables

The deployment stacks read these variables, and the app's own config does not,
so they only matter once you leave your laptop. Each is documented in the page
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

Everything is a `pnpm` script. You will use `dev`, `test` and the pre-push
verify chain daily. The rest are listed here so you do not have to go digging
in `package.json`.

| Command                                                                 | Description                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| `pnpm dev`                                                              | Start the dev server (Turbopack)                   |
| `pnpm build` / `pnpm start`                                             | Production build / serve                           |
| `pnpm lint` · `pnpm lint:fix`                                           | ESLint                                             |
| `pnpm typecheck`                                                        | `tsc --noEmit`                                     |
| `pnpm format` · `pnpm format:check`                                     | Prettier                                           |
| `pnpm test` · `pnpm test:watch` · `pnpm test:coverage`                  | Vitest units                                       |
| `pnpm test:e2e` · `pnpm test:e2e:ui`                                    | Playwright E2E                                     |
| `pnpm db:generate` · `db:migrate` · `db:push` · `db:studio` · `db:seed` | Database (see [Database](database.md))             |
| `pnpm rag:eval`                                                         | Retrieval evaluation (see [RAG](rag.md))           |
| `pnpm rag:eval --compare`                                               | Fixed pipeline vs agentic, side by side            |
| `pnpm rag:eval --label x --baseline y`                                  | Save a run; fail on a refusal regression           |
| `pnpm rag:eval --no-ingest`                                             | Reuse what is already indexed                      |
| `pnpm rag:corpus`                                                       | Rebuild the eval corpus PDFs                       |
| `pnpm gen:icons` · `pnpm gen:og`                                        | Regenerate PWA icons · OG share image              |
| `pnpm docs:check`                                                       | Check every doc is indexed and every link resolves |
| `pnpm specs:index` · `pnpm specs:check`                                 | Regenerate · verify the spec index                 |
| `pnpm release:next`                                                     | Suggest the next version from commits              |
| `pnpm release:check`                                                    | Check a release before tagging it                  |
| `pnpm pr:check`                                                         | The PR check, locally (`PR_TITLE`/`PR_BODY`)       |
| `pnpm docker:db`                                                        | Start the local Postgres container                 |
| `pnpm docker:minio`                                                     | Start local MinIO + bucket init                    |
| `pnpm docker:mail`                                                      | Start local Mailpit (email catcher)                |

Run this before every push. CI runs the same gate on every PR, but a failure
caught locally is faster to fix:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Testing

There are two suites. Unit tests are fast, need nothing running, and cover the
logic that is easy to get subtly wrong. End-to-end tests drive a real browser
against a real database, object store and mail catcher, and cover the flows a
user actually performs.

```bash
pnpm test            # unit tests (Vitest)
pnpm test:coverage   # units with coverage
pnpm test:e2e        # E2E (needs a migrated DB + running/built app)
```

- Unit tests live in `tests/unit/`. They cover password hashing, validation
  schemas, upload validation, rate limiting, single-use tokens, RBAC, OAuth
  config, the email soft-gate guard, and Web Push send/prune. The `server-only`
  guard is stubbed for the test runner (see `vitest.config.ts`).
- E2E tests live in `tests/e2e/`. They cover auth flows, protected-route
  redirects, RBAC, file upload/download/delete, avatars, PWA
  (manifest/SW/offline), SEO (robots/sitemap/OG) and a11y (axe). They also run
  the full email reset/verification round-trips against Mailpit
  (`email-flow.spec.ts`, which skips itself if Mailpit is down) and the RAG
  product end to end: ingestion, citations, refusal, conversation history, and
  cross-knowledge-base isolation (`rag.spec.ts`, `chat.spec.ts`,
  `knowledge-bases.spec.ts`). The RAG specs skip themselves without
  `NVIDIA_API_KEY` and always skip in CI, so run them locally.
- The RAG unit tests cover chunking, scope resolution, the router, the planner
  adapters, the bounded loop and its budgets, and citation stripping. They also
  include SQL-text assertions that both tenant and knowledge-base isolation are
  present in every retrieval channel.

Each test uses a unique client IP to isolate rate-limit buckets
(`tests/e2e/fixtures.ts`), and a `globalSetup` seeds the demo admin. Playwright
boots `pnpm dev` locally, and `pnpm start` when the `CI` environment
variable is set.

### Rate limits and the `--workers=1` rule

**With `RAG_AGENTIC_ENABLED=true`, run E2E with `--workers=1`.** Each agentic
question costs 5 to 8 upstream calls against a ~40/min ceiling, so parallel
workers end up measuring contention with your own rate limiter instead of the
product. The same applies to `pnpm rag:eval --compare`: never run two at once.
[RAG](rag.md) works through what each path costs per question.

To get a full green run against a live database, object store, and mail
catcher:

```bash
pnpm docker:db && pnpm docker:minio && pnpm docker:mail && \
  pnpm db:migrate && pnpm build && pnpm test:e2e
```

## Docker

There are two ways to use Docker here. Day to day you only want the
dependencies (Postgres, MinIO, and a local mail catcher), with the app itself
running from `pnpm dev` so hot reload works:

```bash
pnpm docker:db          # docker compose up -d db
pnpm docker:minio       # docker compose up -d minio minio-init
pnpm docker:mail        # docker compose up -d mailpit
```

The second way runs the whole thing in containers, the way it runs in
production. Use it when you need to test the production build. Thrown Server
Action errors are redacted in a production build but not under `next dev`, so
some bugs only appear here:

```bash
AUTH_SECRET=$(openssl rand -base64 33) \
  docker compose -f docker-compose.prod.yml up --build
```

That stack has seven services:

| Service        | Kind       | What it does                                                                                   |
| -------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `db`           | long-lived | `pgvector/pgvector:pg17`: Postgres with the vector extension, on the `pgdata` volume           |
| `migrate`      | one-shot   | Runs `pnpm db:migrate` once and exits; the app waits for it to complete                        |
| `minio`        | long-lived | S3-compatible object storage, on the `miniodata` volume. No published ports                    |
| `minio-init`   | one-shot   | Creates the app bucket, then exits. Idempotent, safe to re-run                                 |
| `db-backup`    | long-lived | Nightly compressed Postgres dumps into `./backups/postgres`, pruned to `BACKUP_RETENTION_DAYS` |
| `minio-backup` | long-lived | Mirrors the bucket into `./backups/minio` every `BACKUP_INTERVAL_SECONDS`                      |
| `app`          | long-lived | The Next.js app on port 3000, started only after `migrate` and `minio-init` succeed            |

The app image is a multi-stage build using Next.js `standalone` output. It runs
as a non-root user and exposes `/api/health` as a container healthcheck. MinIO
has no published ports in this stack, and the app is the only public gateway to
it, which is why uploads and downloads are proxied through the app instead of
presigned.

Before you test document chat in that stack, note that the compose files set
the database and storage variables inline on the `app` service and **do not
pass `NVIDIA_API_KEY` or the `RAG_*` variables through**. Add them to the `app`
service's `environment:` block if you want the chat configured there. See
[Backups](backups.md) for the backup sidecars and
[Self-hosting](self-hosting.md) for the deploy stacks.

## Git hooks

Husky installs a `pre-commit` hook that runs lint-staged (ESLint + Prettier on
staged files), and a `commit-msg` hook that enforces Conventional Commits. The
`prepare` script wires them up on `pnpm install`. To bypass them in an
emergency, use `git commit --no-verify`.

## Continuous integration

`.github/workflows/ci.yml` runs on every PR and push to `main`. It checks
format, lint and typecheck, runs unit tests with coverage and `specs:check`,
and runs the Playwright suite against Postgres, MinIO and Mailpit. A green
`main` publishes the app and migrate images to GHCR, and a `v*` tag re-tags
them and creates the GitHub Release. Run the same gate locally before a push:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`.github/workflows/deploy.yml` is an opt-in self-hosted deploy triggered by a
`v*` tag. It only runs if the repo variable `SELF_HOSTED_DEPLOY` is set, and it
is unset. [CI/CD](ci-cd.md) covers it job by job, and
[Deployment](deployment.md) covers how deploys reach the box.

## Extending

This table lists common changes and where to make them. Anything that touches
the database schema follows the migration workflow in [Database](database.md):
edit the schema, generate the migration, review it, commit it, and apply it.

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
| Add an AI setting           | Add the field to `src/lib/ai-env.ts` and `.env.example`; read it with `aiSettings().RAG_X`                                     |
| Turn on agentic retrieval   | `RAG_AGENTIC_ENABLED=true` in `.env`, restart. Run `pnpm rag:eval --compare` on your corpus first — see [RAG](rag.md)          |
| Go fully offline            | Point `RAG_LLM_BASE_URL` at Ollama/llama.cpp; the embedding model must emit 2048 dims, the planner must emit native tool calls |
| Use another provider        | Settings → AI provider → Add connection, then pick it for a job under Models. Embeddings stay on the `.env` endpoint for now   |
| Tune the agentic loop       | `RAG_MAX_SEARCHES` / `RAG_MAX_LOOP_MS` / `RAG_MAX_LOOP_TOKENS` / `RAG_AGENTIC_FLOOR_STEP` — [RAG → Tuning](rag.md#tuning)      |

## Production checklist

Work through this list before the app faces real users. Most items are one line
in `.env`, and the list calls out the ones that are not.

- [ ] Unique, strong `AUTH_SECRET` per environment.
- [ ] `DATABASE_URL` on managed Postgres with TLS (`sslmode=require`).
- [ ] Change the default `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` from
      `minioadmin`/`minioadmin`. The default is fine for a MinIO instance with
      no public ingress, but don't leave it if you ever expose MinIO directly.
- [ ] Run `pnpm db:migrate` as a deploy step.
- [ ] Terminate TLS at a trusted proxy; set `AUTH_TRUST_HOST=true`.
- [ ] Swap the in-memory rate limiter for a shared store (e.g. Upstash) if you
      run more than one instance.
- [ ] Wire up error tracking (Sentry). A structured-logging shim
      (`src/lib/logger.ts`) is already in place.
- [ ] Serve over HTTPS so the service worker registers and the app is installable.
- [ ] Replace placeholder icons (`pnpm gen:icons`) and set the manifest name/colors.
- [ ] If using email, set `EMAIL_ENABLED=true` with valid `SMTP_*` credentials and a
      deliverable `EMAIL_FROM` (SPF/DKIM aligned). Leave it off to keep sends inert.
- [ ] Seed or assign an initial `admin` role so the Settings user-management panel is reachable.
- [ ] If document chat is enabled, run `pnpm rag:eval` against your own corpus
      and save it as a baseline, so a later retrieval change can be scored
      instead of argued about. See [RAG](rag.md).

---

**Next:** [RAG — how it works](rag.md) explains what happens between uploading
a PDF and getting a cited answer, and [Database](database.md) covers the schema
and the migration workflow.
