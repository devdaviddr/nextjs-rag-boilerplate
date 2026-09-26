# Features

This page lists everything that ships in this boilerplate, grouped by area, with
a link to the page that explains each piece properly.

Use it as a menu. Each entry says what you get, and the link beside it goes to
the doc that owns the detail.

There are two layers here. On top sits the product: a multi-user document chat
where people upload PDFs into knowledge bases they own and ask questions
answered only from those PDFs. Underneath sits an ordinary production Next.js
application (accounts, roles, file storage, email, a PWA shell, Docker,
backups) that the document chat is built on. You can use the lower layer on
its own. Without an inference API key the app still boots, and the chat pages
report themselves as unconfigured.

Anything labelled optional is inert until you set its environment variables.
Apart from the database, the object store and an auth secret, nothing below is
required to run the app.

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

Ordinary code, not a prompt, enforces two properties: an answer is grounded or
there is no answer, and you can only ever retrieve your own documents.
[RAG: how it works](rag.md) explains both, and defines every term used below.

### What a user can do

- Keep multiple independent knowledge bases per user: create, rename, delete,
  and move a document between them without re-ingesting it.
- Upload PDFs into a chosen knowledge base. This reuses the MinIO storage, quota
  and rate limits from [file uploads](#file-uploads).
- Hold conversations scoped to a set of knowledge bases. The scope is fixed when
  the thread is created, so every message in it has one auditable scope.
- Read streamed Markdown answers with clickable page-level citations that open
  the source PDF, plus conversation history and per-answer generation metrics.

### How a PDF becomes searchable

This is _ingestion_, the one-off background job that turns an upload into rows
you can search. [RAG](rag.md) walks through each step.

- Extraction runs in-process with `unpdf`. Image-only PDFs are rejected instead
  of being half-ingested.
- Chunking is token-aware and page-bounded, so every citation resolves to an
  exact page.
- Chunks embed their document title and detected section heading alongside the
  content, while storing the original text for display.
- Vectors use `pgvector` `halfvec(2048)` with an HNSW cosine index inside the
  existing Postgres, so there is no additional service and no vector database
  to run.

### How a question is answered

- There are two retrieval paths: similarity search for content questions, and
  whole-document retrieval for summarise/overview requests.
- Retrieval is hybrid. A meaning-based channel (`pgvector` HNSW) and a keyword
  channel (`tsvector` GIN) run side by side in the same Postgres table and are
  fused with Reciprocal Rank Fusion.
- Retrieval is scoped to the owner and the knowledge base in the SQL `WHERE`
  clause, per channel. It is never a join, and never a filter applied to
  results afterwards.
- Answers are grounded: when nothing clears the similarity floor, the chat model
  is never called.

### Optional: agentic retrieval

`RAG_AGENTIC_ENABLED`, on by default. The model plans its own searches via a
tool call, resolves conversational references, and can search again when the
first attempt is thin, inside hard caps on searches, wall-clock and tokens.
Citation verification then strips claims their sources do not support. It is
roughly ten times slower and markedly better on follow-ups. The measured A/B is
in [RAG → The agentic path](rag.md#the-agentic-path).

### Choosing the provider and models from Settings

Admins get a **Configuration** section in **Settings** (spec 0040):

- **AI provider** lists the endpoints the app can send questions to. The
  `.env` endpoint is always there. Add more with a preset (NVIDIA NIM,
  OpenRouter, a llama.cpp server, OpenAI, Ollama, vLLM / LM Studio) or any
  OpenAI-compatible URL. API keys are encrypted at rest (AES-256-GCM) and never
  sent back to the browser; the page shows the last four characters at most.
  **Test** lists the endpoint's models; for OpenRouter the model picker also
  shows each model's context length and price, and requests carry its
  optional attribution headers.
- **Models** sets the connection and model for each job: chat, planner,
  vision and page parsing. A change applies to the next request, with no
  restart. **Test** tries the job as configured: a streamed answer for chat, a
  short completion, a tool call for the planner (a llama.cpp planner without
  `--jinja` is told so), or one embedding of the size the index needs (a
  llama.cpp server without `--embeddings` is told so). **Use .env** removes
  the change.
- **Retrieval & answering** holds the switches and limits behind search:
  passages per answer, the relevance floor, agentic search and its limits,
  reranking, and how documents are processed. Each is saved on its own,
  applies to the next question, and is refused with the allowed range if out
  of bounds. Passage size and document cracking affect documents uploaded
  after the change.
- **Recent changes** lists who changed what, old → new. API keys appear only
  as their last four characters.

Every setting shows where its value comes from: the default, `.env`, or saved
here (with who saved it). `AI_SETTINGS_LOCKED=true` makes the whole section
read-only, for deployments that keep their AI config in `.env`.

A new **embedding** model re-indexes every document before it is used, because
the index holds one model's vectors and two models' vectors cannot be compared.
Settings asks first, shows progress, and can cancel; search stays on the
current model until the new index is complete. Embeddings stay on the `.env`
endpoint for now. Choosing a
provider also chooses who sees your document text: the questions and the
retrieved passages go to it.

### Watching an answer being built

Every answer in a chat has an **Agent activity** link under it. Open it while
the answer is being written and it follows along live: each step with its
timing (finding passages, each thing the planner decided, each search, writing
the answer, checking its citations) and a plain line for each thing that
happened, such as "Decided to search for 'leave policy'" or "Found 5 passages
(best match 0.73)". Open it on an older answer and it shows what was recorded
then. Everyone sees this for their own answers; admins also get each line's
raw details and links to the full run and its log lines (spec 0042 FR12).

### Observability: what the pipeline is doing

Admins get an **Observability** item in the sidebar (spec 0042). **Logs** shows
every log line the server writes, live, newest at the bottom: the level as a
coloured badge (error, warn, info, debug), the area as a coloured stripe
(agent, retrieval, inference, ingestion, auth, settings, system), and the full
details a click away. Every line written while answering one question shares a
request id, so one click shows that question's whole story: what the planner
chose, what each search found, reranking, and any provider errors and
retries. Lines are kept in Postgres for `LOG_RETENTION_DAYS` (7 by default),
with API keys and other secrets removed before they are stored.

**Runs** lists every question answered and every document ingested, with its
outcome (answered, no match, failed, cancelled), how long it took, time to the
first word, tokens and best match. Open one to see its steps as a timeline you
can replay: finding passages, each thing the planner decided, each search,
writing the answer and checking its citations, each with the model it used,
its tokens, and what it found. Runs are kept for `TELEMETRY_RETENTION_DAYS`
(30 by default).

**Overview** is the dashboard, for the last 24 hours or 7 days against the
period before: questions asked, how often nothing matched, answer time and
time to the first word, tokens per answer and the failure rate, each with a
trend line. Below them: questions and answer times over time, which retrieval
mode was used, why agentic searches stopped, documents processed, how close
each question's best passage came to the similarity floor, where the time goes
step by step, which models failed, and the latest runs.

### Measured, not asserted

A retrieval evaluation harness (`pnpm rag:eval`) runs a ground-truth corpus and
reports hit@k, MRR, refusal accuracy and cross-knowledge-base leakage, so a
retrieval change is measured instead of assumed. A refusal-accuracy regression
against a saved baseline fails the run outright. The corpus, the metrics and the
measured numbers are in [RAG](rag.md).

### Built for a flaky free tier

The client retries on 429/5xx and on bodiless 404s, retries once for a draft
that streams nothing, and shows an explicit error instead of a blank bubble when
it still fails. Answers are persisted even if you navigate away.

For the full walkthrough, see [RAG: how it works](rag.md).

## Authentication

Sign-in is email and password out of the box, with GitHub and Google available
as opt-in extras. Sessions are JSON Web Tokens (JWTs) instead of server-side
session rows, so a page can read who you are without a database round-trip.

- Email + password sign-in uses Auth.js (NextAuth) v5.
- Passwords are hashed with Argon2id (`@node-rs/argon2`) using
  OWASP-recommended parameters.
- The JWT session strategy carries the user id on the token and session.
- Routes are protected at the edge: a lightweight `proxy.ts` guards protected
  paths on the edge runtime, and pages re-check server-side. Checking the same
  thing in two independent places is
  [defence in depth](architecture.md#what-a-page-request-does).
- Login resists user enumeration. A failed login runs a dummy hash verify, so
  the response takes the same time whether or not the account exists, and an
  attacker learns nothing from the clock.
- Sessions are resilient. An undecryptable cookie (say, after an `AUTH_SECRET`
  rotation) is treated as "signed out" instead of crashing the request.
- OAuth with GitHub and Google is opt-in, via the Auth.js Drizzle adapter, on
  the same `users` table and JWT sessions as Credentials. Accounts that merely
  share an email address are never linked automatically. A "Connected accounts"
  panel links and unlinks providers, and refuses to unlink the last way you have
  of signing in. See [OAuth](oauth.md).
- Password reset and email verification are opt-in with email. Each link
  carries a single-use token that works for one purpose only and is stored
  hashed, never in the clear. Requesting a reset gives the same answer whether
  or not the address is registered. Verification can be enforced as an optional
  [soft gate](email.md#email-verification-and-the-soft-gate): a banner and
  blocked admin mutations, without locking the user out. See [Email](email.md).

See [Architecture → Authentication](architecture.md#authentication-design) for the design.

## Access control (RBAC)

**Role-based access control** means users hold named roles such as `admin` or
`member`, and both the edge and the server decide what each role may reach.

- Roles live in `roles` + `user_roles` (many-to-many) and are carried as a
  `roles: string[]` claim on the JWT and session, so reading them needs no extra
  DB round-trip.
- Server guards `requireRole()` / `requireAnyRole()` / `hasRole()`
  (`src/lib/auth/rbac.ts`) assert roles inside Server Actions and RSCs, and
  failures throw `ForbiddenError`.
- At the edge, an optional `ROLE_REQUIRED` prefix map in `proxy.ts` redirects
  unauthorised users to `/403`. This check is JWT-only (no Node deps at the
  edge).
- Client helpers `useRole()` and `<RequireRole>` (`src/lib/auth/client-rbac.tsx`)
  handle conditional UI. They are cosmetic; the server checks remain
  authoritative.
- A Settings panel for admins (admin-gated server-side) lists users, creates,
  edits and deletes them, and assigns roles.
- Sessions heal themselves: old JWTs missing the `roles` claim re-fetch roles
  once and back-fill the token.

## Invite-based account claim

An admin can create an account without ever choosing a password for it. The
person named on the account sets their own, once, through a link that stops
working afterwards.

- Admins create users with no password, and the account is claimed later via a
  one-time link.
- Invite tokens are single-use (`src/lib/auth/invite.ts`). A 32-byte token is
  shown to the admin once. Only its SHA-256 hash is stored
  (`users.invite_token_hash`), and the comparison is time-safe: it takes the
  same time whatever the token, so guesses cannot be narrowed down by timing.
  Tokens expire in 7 days.
- The claim flow at `/register?invite=…&email=…` sets the password and consumes
  the invite. Knowing the email alone is not enough, so the page gives away
  nothing about who has an account.

## Email (optional)

Nothing sends mail until you turn it on. When you do, one SMTP configuration
covers invites, password resets and verification links, with no separate setup
per flow.

- Email is off by default. Everything email-related is inert unless
  `EMAIL_ENABLED=true` **and** an SMTP provider is configured. Enabling it
  without a provider fails fast at boot instead of dropping mail silently.
- The SMTP layer is provider-agnostic (`src/lib/email/`) and works with Resend,
  SendGrid, Mailgun, SES, Postmark, or Gmail via their SMTP credentials.
  `nodemailer` is loaded lazily, so it is never bundled when email is off and
  never reaches the edge runtime.
- Sending is a safe no-op when disabled: `sendEmail()` returns `{ skipped }`.
  It never throws on a send failure, so a flaky mail server cannot break the
  action that triggered it.
- Invites, password reset and email verification all use it. Invite links are
  emailed when enabled, and still shown in the admin UI as a fallback. Reset and
  verification links go out the same path.

See [Email](email.md) to configure it and for the reset/verification flows.

## Web Push notifications (optional)

The app can send a notification to a device even when nobody has the tab open.
It is off until you generate a keypair, and each browser subscribes separately.

- Push is opt-in. It is inert, including the Settings toggle, unless
  `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` are set. Generate
  keys with `npx web-push generate-vapid-keys`.
- Subscriptions are per device (`push_subscriptions`), and you enable or disable
  them from Settings. The private key never reaches the client.
- The server send helpers (`src/lib/push/`) are
  `sendPushNotification(userId, …)` and `notifyRole('admin', …)`. Both are
  best-effort: a send failure never blocks the action that triggered it, and a
  subscription the push service reports as gone (404/410) is pruned
  automatically.
- As a worked example, admins are notified when a new user self-registers.
- The service worker shows the notification on `push` and focuses or opens the
  right tab on `notificationclick`. It is active in production builds. See
  [Web Push](push.md).

## Database

One PostgreSQL database holds everything, including the vectors. There is no
separate vector store to run, back up or keep in sync.

- PostgreSQL 17 with Drizzle ORM, which is type-safe and close enough to SQL
  that you can read what it will run.
- pgvector for the RAG tables, so the vector index lives in the same database as
  the users and the documents that own it.
- drizzle-kit migrations, committed under `drizzle/`.
- A pooled, hot-reload-safe client, and a seed script you can run repeatedly
  without duplicating rows.

See [Database](database.md).

## File uploads

Files live in your own object store, and the app is the only thing that talks to
it. Nothing is uploaded straight from a browser to a bucket.

- Storage is self-hosted and S3-compatible, via MinIO. It needs no cloud
  account, and it works unmodified against R2/S3 if you ever want to swap.
- Uploads and downloads are proxied through the app (`src/lib/storage/`)
  instead of using presigned direct URLs, so MinIO itself is never publicly
  exposed and needs no second Cloudflare Tunnel hostname.
- Everything is validated before it is stored. Size (`UPLOAD_MAX_SIZE_MB`), MIME
  type (`UPLOAD_ALLOWED_MIME_TYPES` allow-list), and a per-user storage quota
  (`MAX_STORAGE_PER_USER_MB`) are all enforced server-side.
- Downloads are ownership-checked. `GET /api/files/[id]` streams an object back
  only to its owner, and a non-owner gets the same 404 whether the file exists
  or not, so there is no existence signal.
- Uploads are rate-limited, and a "My Files" panel in Settings (list, download,
  delete) is available to every signed-in user, not only admins.
- Deleting a user removes their files' objects and rows too, so no storage is
  orphaned.
- Every signed-in user can upload, replace or remove their own profile photo
  from Settings, built entirely on the storage above. Avatars have narrower
  size/type limits than general uploads and still count against the same
  per-user quota. They surface through Auth.js's standard `session.user.image`
  and show in the app shell topbar and Settings without a page reload (see
  [spec 0018](../specs/0018-profile-photo-upload.md)).

See [spec 0007](../specs/0007-file-uploads.md). PDF ingestion for the knowledge
bases reuses this same storage, quota and rate limiting.

## Progressive Web App

The app can be installed to a home screen and opened like a native one. The
service worker is written by hand instead of generated, so you can read exactly
what it caches.

- Installable web app manifest, a generated icon set (including maskable icons),
  a theme colour, and iOS home-screen metadata.
- Hand-rolled service worker with auth-safe caching: static assets are cached,
  API and auth responses never are.
- An offline fallback page and an install prompt.
- No extra runtime dependencies and no bundler change, so the build stays on
  Turbopack.

See [PWA & App Shell](pwa.md).

## UI & responsive shell

One shell wraps every signed-in page: a sidebar on desktop, a drawer on mobile,
and a theme that survives a reload without a flash of the wrong colours.

- Tailwind CSS v4 + shadcn/ui components.
- Light / dark / system theming (`next-themes`), with a toggle in the app shell
  and on auth pages. There is no flash of the wrong theme: the anti-flash script
  runs under the strict CSP via the per-request nonce, with no `script-src`
  loosening. See [spec 0013](../specs/0013-dark-mode-theming.md).
- A minimal, borderless app shell: brand lockup (app icon + wordmark), fixed
  sidebar on desktop, off-canvas drawer on mobile, sticky topbar.
- Safe-area insets for installed PWA (notch-aware).
- Data-driven navigation with active-state highlighting.
- Auth pages (login/register) with accessible forms and inline validation.

## SEO & social sharing

A link to the app unfurls with a preview card wherever it is pasted, and search
engines get a sitemap without you writing one.

- OpenGraph + Twitter card metadata and a default share image (`public/og.png`,
  regenerate with `pnpm gen:og`), so shared links unfurl with a preview card.
- `metadataBase` (from `APP_URL`) resolves relative image URLs absolutely, and
  `robots.txt` and `sitemap.xml` come from Next's file conventions. See
  [spec 0019](../specs/0019-seo-opengraph-metadata.md).

## Developer experience

The tooling is set up to fail early (at compile time, at commit time, or at
boot) and not at 2am in production.

- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`).
- ESLint (flat config, `eslint-config-next`) + Prettier (+ Tailwind plugin).
- Husky `pre-commit` running lint-staged.
- Path alias `@/*`, editor recommendations (`.vscode/`).
- A Zod-validated environment that fails fast at boot.

## Testing

Unit tests cover pure logic, browser tests cover the flows a user actually
walks, and the RAG suites skip themselves when there is no API key.

- Vitest + Testing Library for units (password hashing, validation schemas).
- Playwright for E2E (full auth flow, protected-route redirects, PWA
  manifest/SW/offline).
- RAG suites covering chunking, retrieval scoping, the agentic loop's budgets,
  and the product end to end. They self-skip without `NVIDIA_API_KEY`.
- Runs locally against a real Postgres.

The full scope of each suite, and the `--workers=1` rule for the agentic path,
is in [Usage → Testing](usage.md#testing).

## Delivery

Everything needed to run this on a machine you own is in the repo: the images,
the compose files, the backup sidecars and the tunnel.

- A multi-stage Dockerfile with Next.js `standalone` output, a non-root user and
  a healthcheck.
- docker-compose for local Postgres and a full production-like stack (app + db +
  one-shot migrator + MinIO).
- Automated backups: nightly Postgres dumps + MinIO mirror with retention, a
  `backup-verify.sh` doctor, and a tested restore runbook. See
  [Backups](backups.md).
- Cloudflare Tunnel deployment. `make setup` takes a fresh clone to a live HTTPS
  URL with no open ports, and `make deploy` is continuous deployment after that.
  See [Self-hosting](self-hosting.md) and [Deployment](deployment.md).
- In-app documentation. A Docs section in the sidebar renders these `docs/*.md`
  pages inside the app, signed-in only, with a grouped index, table of contents,
  in-app links and Mermaid diagrams. `pnpm docs:check` keeps every link and
  anchor valid (spec 0041).
- A CI pipeline. GitHub Actions runs format, lint, typecheck, unit tests with
  coverage, `specs:check` and the Playwright suite on every PR and push to
  `main`, then publishes multi-arch app + migrate images to GHCR. A `v*` tag
  re-tags the tested image in ~30s and creates the GitHub Release. See
  [CI/CD](ci-cd.md).

See [Usage & Development](usage.md) and [Deployment](deployment.md).

---

Next, [OAuth (GitHub & Google)](oauth.md) sets up third-party sign-in, and
[Usage & Development](usage.md) is the day-to-day command reference.
