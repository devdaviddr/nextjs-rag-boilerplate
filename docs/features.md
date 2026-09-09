# Features

[← Back to README](../README.md)

**What this covers:** everything that ships in this boilerplate, grouped by
area, with a link to the page that explains each piece properly.

Read this page as a menu, not a manual. Each entry says what you get; the link
beside it goes to the doc that owns the detail.

There are two layers here. On top sits the product: a multi-user document chat
where people upload PDFs into knowledge bases they own and ask questions
answered only from those PDFs. Underneath sits an ordinary production Next.js
application — accounts, roles, file storage, email, a PWA shell, Docker,
backups — that the document chat is built on. You can use the lower layer on
its own; without an inference API key the app still boots and the chat pages
simply report themselves as unconfigured.

Anything labelled **optional** is inert until you set its environment
variables. Nothing below is required to run the app except the database, the
object store and an auth secret.

## At a glance

| Area                                                     | What you get                                                   | Read more                                              |
| -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| [RAG document chat](#rag--knowledge-base--document-chat) | Knowledge bases, PDF ingestion, cited answers, an eval harness | [RAG](rag.md)                                          |
| [Authentication](#authentication)                        | Email + password, OAuth, password reset, verification          | [Architecture](architecture.md), [OAuth](oauth.md)     |
| [Access control](#access-control-rbac)                   | Roles on the JWT, server guards, edge gating, an admin panel   | [Architecture](architecture.md)                        |
| [Invite claim](#invite-based-account-claim)              | Admin creates an account, the user claims it by one-time link  | [Email](email.md)                                      |
| [Email](#email-optional)                                 | Provider-agnostic SMTP, reset + verification flows             | [Email](email.md)                                      |
| [Web Push](#web-push-notifications-optional)             | VAPID keys, per-device subscriptions, server send helpers      | [Web Push](push.md)                                    |
| [Database](#database)                                    | Postgres 17 + pgvector, Drizzle ORM, committed migrations      | [Database](database.md)                                |
| [File uploads](#file-uploads)                            | Self-hosted S3-compatible storage, quotas, profile photos      | [spec 0007](../specs/0007-file-uploads.md)             |
| [PWA](#progressive-web-app)                              | Manifest, hand-rolled service worker, offline page             | [PWA & App Shell](pwa.md)                              |
| [UI shell](#ui--responsive-shell)                        | Tailwind v4 + shadcn/ui, theming, sidebar/drawer shell         | [PWA & App Shell](pwa.md)                              |
| [SEO](#seo--social-sharing)                              | OpenGraph + Twitter cards, robots, sitemap                     | [spec 0019](../specs/0019-seo-opengraph-metadata.md)   |
| [Developer experience](#developer-experience)            | Strict TypeScript, ESLint, Prettier, validated env             | [Usage & Development](usage.md)                        |
| [Testing](#testing)                                      | Vitest units, Playwright E2E, RAG suites                       | [Usage → Testing](usage.md#testing)                    |
| [Delivery](#delivery)                                    | Multi-stage Docker image, compose stacks, nightly backups      | [Self-hosting](self-hosting.md), [Backups](backups.md) |

## RAG — knowledge base & document chat

This is the reason the template exists. A user uploads PDFs into a knowledge
base, asks a question, and gets an answer written only from passages the system
actually found in those PDFs, with the page number attached to each claim.

Two properties are enforced by ordinary code rather than by asking a model
nicely: an answer is grounded or there is no answer, and you can only ever
retrieve your own documents. **[RAG — how it works](rag.md)** explains both,
and defines every term used below.

### What a user can do

- **Multiple independent knowledge bases** per user — create, rename, delete,
  and move a document between them without re-ingesting it
- **PDF upload** into a chosen knowledge base (reuses the MinIO storage, quota
  and rate limits from [file uploads](#file-uploads))
- **Conversations scoped to a set of knowledge bases**, fixed when the thread
  is created, so every message in it has one auditable scope
- **Streamed Markdown answers** with clickable page-level citations that open
  the source PDF, conversation history, and per-answer generation metrics

### How a PDF becomes searchable

This is _ingestion_ — the one-off background job that turns an upload into
rows you can search. [RAG](rag.md) walks through each step.

- **In-process extraction** with `unpdf`; image-only PDFs are **rejected**, not
  half-ingested
- **Token-aware, page-bounded chunking** so every citation resolves to an exact
  page
- Chunks embed their **document title and detected section heading** alongside
  the content, while storing the original text for display
- `pgvector` **`halfvec(2048)` with an HNSW cosine index**, inside the existing
  Postgres — no additional service, and no vector database to run

### How a question is answered

- **Two retrieval paths** — similarity search for content questions,
  whole-document retrieval for summarise/overview requests
- **Hybrid retrieval** — a meaning-based channel (`pgvector` HNSW) and a
  keyword channel (`tsvector` GIN) run side by side and are fused with
  Reciprocal Rank Fusion, both in the same Postgres table
- **Owner- and knowledge-base-scoped retrieval** enforced in the SQL `WHERE`
  clause, per channel — never a join, never a filter applied to results
  afterwards
- **Grounded answers**: when nothing clears the similarity floor the chat model
  is **never called**

### Optional: agentic retrieval

`RAG_AGENTIC_ENABLED`, off by default. The model plans its own searches via a
tool call, resolves conversational references, and can search again when the
first attempt is thin, inside hard caps on searches, wall-clock and tokens.
Citation verification then strips claims their sources do not support. It is
roughly ten times slower and markedly better on follow-ups — the measured A/B
is in [RAG → The agentic path](rag.md#the-agentic-path).

### Measured, not asserted

A **retrieval evaluation harness** (`pnpm rag:eval`) runs a ground-truth corpus
and reports hit@k, MRR, refusal accuracy and **cross-knowledge-base leakage**,
so a retrieval change is measured rather than assumed. A refusal-accuracy
regression against a saved baseline fails the run outright. The corpus, the
metrics and the measured numbers are in [RAG](rag.md).

### Built for a flaky free tier

Retries on 429/5xx and on bodiless 404s, one retry for a draft that streams
nothing, an explicit error rather than a blank bubble when it still fails, and
answers persisted even if you navigate away.

Full walkthrough: **[RAG — how it works](rag.md)**.

## Authentication

Sign-in is email and password out of the box, with GitHub and Google available
as opt-in extras. Sessions are JSON Web Tokens (JWTs) rather than server-side
session rows, so a page can read who you are without a database round-trip.

- **Email + password** via Auth.js (NextAuth) v5.
- **Argon2id** password hashing (`@node-rs/argon2`) with OWASP-recommended
  parameters.
- **JWT session strategy** with the user id carried on the token and session.
- **Edge-protected routes** — a lightweight `proxy.ts` guards protected paths on
  the edge runtime, and pages re-check server-side. Checking the same thing in
  two independent places is
  [defence in depth](architecture.md#what-a-page-request-does).
- **User-enumeration resistance** — a failed login runs a dummy hash verify, so
  the response takes the same time whether or not the account exists and an
  attacker learns nothing from the clock.
- **Resilient sessions** — an undecryptable cookie (say, after an `AUTH_SECRET`
  rotation) is treated as "signed out" instead of crashing the request.
- **OAuth — GitHub & Google** (opt-in) via the Auth.js Drizzle adapter, on the
  same `users` table and JWT sessions as Credentials. There is no automatic
  linking of accounts that merely share an email address. A "Connected accounts"
  panel links and unlinks providers, and refuses to unlink the last way you have
  of signing in. See [OAuth](oauth.md).
- **Password reset & email verification** (opt-in with email) — each link
  carries a single-use token that works for one purpose only and is stored
  hashed, never in the clear. Requesting a reset gives the same answer whether
  or not the address is registered. Verification can be enforced as an optional
  [soft gate](email.md#email-verification-and-the-soft-gate) — a banner and
  blocked admin mutations, not a lock-out. See [Email](email.md).

See [Architecture → Authentication](architecture.md#authentication-design) for the design.

## Access control (RBAC)

Role-based access control: users hold named roles such as `admin` or `member`,
and both the edge and the server decide what each role may reach.

- **Roles model** — `roles` + `user_roles` (many-to-many); roles are carried as a `roles: string[]` claim
  on the JWT and session (no extra DB round-trip to read them).
- **Server guards** — `requireRole()` / `requireAnyRole()` / `hasRole()` (`src/lib/auth/rbac.ts`) assert roles inside Server Actions
  and RSCs; failures throw `ForbiddenError`.
- **Edge gating** — an optional `ROLE_REQUIRED` prefix map in `proxy.ts` redirects unauthorised
  users to **`/403`**, JWT-only (no Node deps at the edge).
- **Client helpers** — `useRole()` and `<RequireRole>` (`src/lib/auth/client-rbac.tsx`) for conditional UI (cosmetic — server
  checks remain authoritative).
- **Admin user management** — a Settings panel (admin-gated server-side) to list
  users and create / edit / delete them and assign roles.
- **Self-healing sessions** — old JWTs missing the `roles` claim re-fetch roles once
  and back-fill the token.

## Invite-based account claim

An admin can create an account without ever choosing a password for it. The
person named on the account sets their own, once, through a link that stops
working afterwards.

- **Passwordless provisioning** — admins create users with no password, and the
  account is claimed later via a one-time link.
- **Single-use invite tokens** (`src/lib/auth/invite.ts`) — a 32-byte token is
  shown to the admin once. Only its **SHA-256 hash** is stored
  (`users.invite_token_hash`), and the comparison is time-safe: it takes the
  same time whatever the token, so guesses cannot be narrowed down by timing.
  Tokens expire in 7 days.
- **Claim flow** — `/register?invite=…&email=…` sets the password and consumes
  the invite. Knowing the email alone is not enough, so the page gives away
  nothing about who has an account.

## Email (optional)

Nothing sends mail until you turn it on. When you do, one SMTP configuration
covers invites, password resets and verification links — there is no separate
setup per flow.

- **Off by default** — everything email-related is inert unless
  `EMAIL_ENABLED=true` **and** an SMTP provider is configured. Enabling it
  without a provider **fails fast at boot** rather than dropping mail silently.
- **Provider-agnostic SMTP** (`src/lib/email/`) — works with Resend, SendGrid,
  Mailgun, SES, Postmark, or Gmail via their SMTP credentials. `nodemailer` is
  loaded lazily, so it is never bundled when email is off and never reaches the
  edge runtime.
- **Safe no-op** — `sendEmail()` returns `{ skipped }` when disabled, and never
  throws on a send failure, so a flaky mail server cannot break the action that
  triggered it.
- **Wired to invites, password reset, and email verification** — invite links
  are emailed when enabled, and still shown in the admin UI as a fallback.
  Reset and verification links go out the same path.

See [Email](email.md) to configure it and for the reset/verification flows.

## Web Push notifications (optional)

The app can send a notification to a device even when nobody has the tab open.
It is off until you generate a keypair, and each browser subscribes separately.

- **Opt-in** — inert, including the Settings toggle, unless `VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` are set. Generate keys with
  `npx web-push generate-vapid-keys`.
- **Per-device subscriptions** (`push_subscriptions`) — enable or disable from
  Settings. The private key never reaches the client.
- **Server send helpers** (`src/lib/push/`) —
  `sendPushNotification(userId, …)` and `notifyRole('admin', …)`. Both are
  best-effort: a send failure never blocks the action that triggered it, and a
  subscription the push service reports as gone (404/410) is pruned
  automatically.
- **Worked example** — admins are notified when a new user self-registers.
- **Service worker** shows the notification on `push` and focuses or opens the
  right tab on `notificationclick`. Active in production builds. See
  [Web Push](push.md).

## Database

One PostgreSQL database holds everything, including the vectors. There is no
separate vector store to run, back up or keep in sync.

- **PostgreSQL 17** with **Drizzle ORM** — type-safe, and close enough to SQL
  that you can read what it will run.
- **pgvector** for the RAG tables, so the vector index lives in the same
  database as the users and the documents that own it.
- **drizzle-kit** migrations, committed under `drizzle/`.
- A pooled, hot-reload-safe client, and a seed script you can run repeatedly
  without duplicating rows.

See [Database](database.md).

## File uploads

Files live in your own object store, and the app is the only thing that talks to
it. Nothing is uploaded straight from a browser to a bucket.

- **Self-hosted, S3-compatible object storage** via **MinIO** — no cloud
  account required; works unmodified against R2/S3 if you ever want to swap.
- **Server-proxied, not presigned-direct** — uploads/downloads flow through
  the app (`src/lib/storage/`), so MinIO itself is never publicly exposed and
  needs no second Cloudflare Tunnel hostname.
- **Validated before anything is stored** — size (`UPLOAD_MAX_SIZE_MB`), MIME
  type (`UPLOAD_ALLOWED_MIME_TYPES` allow-list), and a per-user storage quota
  (`MAX_STORAGE_PER_USER_MB`) are all enforced server-side.
- **Ownership-checked downloads** — `GET /api/files/[id]` streams an object
  back only to its owner; a non-owner gets the same 404 whether the file
  exists or not (no existence signal).
- **Rate-limited uploads** and a **"My Files" panel** in Settings (list,
  download, delete) — available to every signed-in user, not admin-gated.
- Deleting a user removes their files' objects and rows too — no orphaned
  storage.
- **Profile photos** — every signed-in user can upload/replace/remove their
  own avatar from Settings, built entirely on the storage above. Narrower
  size/type limits than general uploads; still counts against the same
  per-user quota. Surfaced through Auth.js's standard `session.user.image` —
  shows in the app shell topbar and Settings without a page reload (see
  [spec 0018](../specs/0018-profile-photo-upload.md)).

See [spec 0007](../specs/0007-file-uploads.md). PDF ingestion for the knowledge
bases reuses this same storage, quota and rate limiting.

## Progressive Web App

The app can be installed to a home screen and opened like a native one. The
service worker is written by hand rather than generated, so you can read exactly
what it caches.

- Installable web app manifest, a generated icon set (including maskable icons),
  a theme colour, and iOS home-screen metadata.
- Hand-rolled service worker with **auth-safe caching** — static assets are
  cached, API and auth responses never are.
- An offline fallback page and an install prompt.
- No extra runtime dependencies and no bundler change, so the build stays on
  Turbopack.

See [PWA & App Shell](pwa.md).

## UI & responsive shell

One shell wraps every signed-in page: a sidebar on desktop, a drawer on mobile,
and a theme that survives a reload without a flash of the wrong colours.

- **Tailwind CSS v4** + **shadcn/ui** components.
- **Light / dark / system theming** (`next-themes`) — a toggle in the app shell and on
  auth pages; no flash of wrong theme (the anti-flash script runs under the
  strict CSP via the per-request nonce, no `script-src` loosening). See [spec 0013](../specs/0013-dark-mode-theming.md).
- Minimal, borderless **app shell**: brand lockup (app icon + wordmark), fixed
  sidebar on desktop, off-canvas drawer on mobile, sticky topbar.
- Safe-area insets for installed PWA (notch-aware).
- Data-driven navigation with active-state highlighting.
- Auth pages (login/register) with accessible forms and inline validation.

## SEO & social sharing

A link to the app unfurls with a preview card wherever it is pasted, and search
engines get a sitemap without you writing one.

- **OpenGraph + Twitter card metadata** and a default share image (`public/og.png`,
  regenerate with `pnpm gen:og`) so shared links unfurl with a preview card.
- **`metadataBase`** (from `APP_URL`) resolves relative image URLs absolutely; **`robots.txt`** and
  **`sitemap.xml`** via Next's file conventions. See [spec 0019](../specs/0019-seo-opengraph-metadata.md).

## Developer experience

The tooling is set up to fail early — at compile time, at commit time, or at
boot — rather than at 2am in production.

- **Strict TypeScript** (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`).
- **ESLint** (flat config, `eslint-config-next`) + **Prettier** (+ Tailwind plugin).
- **Husky** `pre-commit` running **lint-staged**.
- Path alias `@/*`, editor recommendations (`.vscode/`).
- Zod-validated environment that **fails fast** at boot.

## Testing

Three layers: unit tests for pure logic, browser tests for the flows a user
actually walks, and RAG suites that skip themselves when there is no API key.

- **Vitest** + Testing Library for units (password hashing, validation schemas).
- **Playwright** for E2E (full auth flow, protected-route redirects, PWA
  manifest/SW/offline).
- **RAG suites** covering chunking, retrieval scoping, the agentic loop's
  budgets, and the product end to end — they self-skip without `NVIDIA_API_KEY`.
- Runs locally against a real Postgres.

The full scope of each suite, and the `--workers=1` rule for the agentic path,
is in [Usage → Testing](usage.md#testing).

## Delivery

Everything needed to run this on a machine you own is in the repo: the images,
the compose files, the backup sidecars and the tunnel.

- **Multi-stage Dockerfile** — Next.js `standalone` output, non-root user, healthcheck.
- **docker-compose** for local Postgres and a full production-like stack (app +
  db + one-shot migrator + MinIO).
- **Automated backups** — nightly Postgres dumps + MinIO mirror with retention,
  a `backup-verify.sh` doctor, and a tested restore runbook. See [Backups](backups.md).
- **Cloudflare Tunnel deployment** — `make setup` takes a fresh clone to a live HTTPS URL
  with no open ports; `make deploy` is continuous deployment after that. See [Self-hosting](self-hosting.md) and [Deployment](deployment.md).
- **No CI pipeline.** `ci.yml` was removed from this fork; the quality gate is the
  pre-commit hook plus `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before a push. The one workflow that remains is an
  opt-in self-hosted deploy gated behind the `SELF_HOSTED_DEPLOY` repo variable. See [CI/CD](ci-cd.md) for the
  record of the former pipeline.

See [Usage & Development](usage.md) and [Deployment](deployment.md).

---

**Next:** [OAuth (GitHub & Google)](oauth.md) sets up third-party sign-in, and
[Usage & Development](usage.md) is the day-to-day command reference.
