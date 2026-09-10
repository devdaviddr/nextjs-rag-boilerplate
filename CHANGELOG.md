# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
As this project is pre-1.0, minor versions may introduce breaking changes.

## [Unreleased]

### Added

- **See what was actually indexed from a document**
  ([spec 0037](specs/0037-inspect-what-was-indexed.md)). Clicking a document
  opens every page of it: what happened to that page in plain language, the
  page image with the indexed regions drawn on it, and the stored text of each
  chunk — the text retrieval actually matches against, not a tidied rendering
  of it.

  The database already recorded all of this and the UI showed none of it. A
  document whose page 8 failed to parse, or that hit its page budget and had
  the rest read the cheap way, displayed the same `Ready` badge as one indexed
  perfectly. So the list gains a **Partly indexed** badge — shown _beside_
  `Ready`, not instead of it, because the document really is searchable and
  part of it really is missing — whenever the budget ran out, a page failed, or
  a recorded page produced no chunks at all. That last one is the case that was
  invisible, and it is the shape of the silent failure document cracking was
  written to fix.

  The badge is derived from the recorded outcomes on every read rather than
  stored, so it cannot drift from what ingestion wrote. A `figure` chunk is
  labelled as a search key and an `ocr` chunk as recovered from an image, so
  neither reads as a quotation. A document ingested before the per-page record
  existed says the routing detail is unknown instead of inventing one, and is
  not marked partial — there is nothing to compare against. Read-only, one page
  image at a time, and nothing on the ingestion or retrieval path changed.

- **A citation highlights the passage, not just the page**
  ([spec 0035](specs/0035-span-level-citations.md)). Opening a source marks the
  cited region on the page instead of leaving the reader to find the sentence
  themselves. A chunk stored with several boxes — a passage spanning two
  columns — highlights each of them; their union would cover the gutter and the
  wrong column.

  A framed PDF viewer cannot be drawn on, so the panel now shows a
  **server-rendered image of the page** with the boxes over it. That is a
  security decision, made deliberately: the alternative, running pdf.js in the
  panel, would put an attacker-supplied PDF inside the authenticated origin's
  JavaScript context, which is exactly the class of bug CVE-2024-4367 was.
  Rendering server-side adds no new exposure at all, because ingestion already
  parses every one of these PDFs with pdf.js in the same process, and what
  reaches the browser is a PNG pinned with `nosniff`. The trade is real: the
  page is a picture, so its text cannot be selected or searched. The document
  itself is still one click away in "Open in new tab", served by the unchanged,
  hardened `/api/documents/[id]/source`.

  Nothing about this is conditional on re-ingesting. A chunk with no stored box
  opens at its page with no highlight, silently — the behaviour every citation
  had before — and so does a page that will not render, which falls back to the
  browser's own viewer. A **figure** citation is outlined rather than filled and
  says in words that it is a description written to make the figure findable,
  not the document's own words: a box around it looks more like a quotation than
  a page number ever did, so the labelling matters more there, not less.

- **Tables, figures and scanned pages can be indexed**
  ([spec 0031](specs/0031-tables-figures-and-complex-layouts.md)), behind
  `RAG_CRACK_ENABLED` (default off). Each page is triaged locally, for free, and
  only pages that need help — multi-column, tabular, image-bearing or scanned —
  are sent to `nvidia/nemotron-parse`, which returns typed, boxed elements
  instead of a flat string. On the evaluation corpus that is 4 parse calls
  across 6 documents; three documents spend nothing, which is the property that
  makes it affordable on a rate-limited tier. A scanned appendix that previously
  ingested as "success" while contributing nothing to the index is now read.
  Chunks gain `kind` and `bbox`, the latter being what span-level citation
  highlighting will need.

  A figure is indexed by a **search key** — its caption where it has one, free
  and in the document's own words, and a generated one-sentence label where it
  does not. What the figure _shows_ is read at answer time by the new
  `read_figure` tool on the agentic loop (`RAG_READ_FIGURE_ENABLED`). That split
  is measured: transcribing a chart blind at ingestion was wrong by 15–30% and
  took 40s, while a specific question against a cropped region was correct in
  4s. Unlabelled quantities remain unreliable under any instruction tested, so a
  deterministic guard replaces any number the figure does not print with
  `[unlabelled]`.

  Budgets degrade rather than fail: past `RAG_CRACK_MAX_PAGES` or
  `RAG_DESCRIBE_MAX_FIGURES` the remaining pages take the text-layer path, the
  document still reaches `ready`, and `documents.extraction` records per page
  which route it took and why.

- **`pnpm rag:eval --answers`** generates an answer from the retrieved context
  and asserts against it, reported separately from `hit@k` because it measures
  generation rather than retrieval.

- **Ingestion survives a restart, and resumes instead of starting over**
  ([spec 0034](specs/0034-resumable-ingestion.md)). A deploy or a crash
  partway through a document used to leave it in "extracting" forever, with
  nothing running and nothing that would ever run again — the only way out was
  deleting it and uploading it again. Now a worker takes a document with a
  10-minute lease, a sweep on boot and every minute afterwards picks up anything
  whose lease has expired, and a document that repeatedly fails to complete ends
  as "failed" with a reason you can read rather than cycling forever.

  Resuming does not re-buy what the interrupted run already paid for. Parser
  output is cached per page, so a document that cracked 20 of 25 pages before a
  restart pays for the remaining 5. A resumed run also spends the same cracking
  budget the original would have, so an interruption cannot quietly produce a
  better-indexed document than an uninterrupted run of the same file.

  This needs no queue, no broker and no second container — the lease is one
  conditional `UPDATE` that Postgres serialises. **Not yet verified against a
  real container kill**: the unit suite mocks the database driver, so it proves
  the SQL is shaped correctly rather than that Postgres serialises two racing
  claims as intended.

### Changed

- **Scanned PDFs are no longer rejected outright** when cracking is enabled.
  With it off, the existing rejection is unchanged.

### Fixed

- **Inference requests are now bounded.** `fetch` has no timeout of its own, so
  a stalled endpoint hung a request indefinitely — measured at 86 seconds on a
  planner call that normally takes 3–6, while the agentic loop's 15-second
  budget could do nothing about it. Every request now carries a 60-second
  per-attempt deadline, so a stall becomes a retry; a caller abort is still
  final and never retried.

- **The agentic loop's wall-clock budget is now a bound rather than a
  checkpoint.** It was read between iterations while every call got the outer
  request signal, so one slow call overran it freely (a 45-second budget
  finishing at 102). Each call now carries a signal composed from the budget it
  has left. Latent since spec 0029; only surfaced once figure reading added a
  call slow enough to expose it.

- **Loop budgets are sized for figure reading when it is enabled.** One
  `read_figure` costs ~13.5s and ~6,600 tokens against text-only defaults of 15s
  and 8,000, so the first look at a picture exhausted the loop and it stopped
  holding a correct reading it never used. Floors of 45s and 30k tokens apply
  with the tool on; they raise a configured value and never lower one.

- **The upload panel no longer claims scanned documents are unsupported** when
  cracking is enabled — the copy now reflects what the deployment actually
  does.

- **Page furniture no longer sends every page to the parser.** With cracking
  enabled, triage counted the ruled header, ruled footer and border box that
  nearly every corporate PDF carries on every page as though they were content,
  so ordinary prose pages cleared the "this page is drawing something"
  threshold on decoration alone. On a realistically styled 8-page report that
  meant **all 8 pages bought a parse call; now 6 do** — the two prose pages are
  free, while the chart, the flowchart, both table pages and the scanned page
  still route. Full-width rules and page-size frames are discounted before
  triage sees them, and the item count no longer includes the empty spacers the
  PDF text layer emits.

  The threshold itself is unchanged, so this narrows what triggers a parse call
  rather than weakening the trigger: the evaluation corpus routes exactly the
  same 6 of 17 pages by exactly the same route as before. That corpus never
  caught the defect because its fixtures have no page template at all, and the
  8-page report it was measured on is not in the repository — so the numbers
  above are not reproducible from a checkout.

### Notes

- Spec 0031 asserted that flattened tables and interleaved columns cost answers.
  Two deliberately destructive evaluation corpora failed to reproduce that: the
  chat model reconstructed both reliably. OCR and figures justify this feature;
  tables and columns are better chunks that have not been shown to be better
  answers. The spec records the contradiction rather than editing its premise.

## [0.20.1] - 2026-09-10

### Fixed

- **Sessions naming a deleted user are now invalidated instead of trusted**
  ([spec 0030](specs/0030-invalidate-sessions-for-deleted-users.md)). A JWT was
  trusted on its signature alone, so a token outlived the row it named: delete
  an account, restore an older backup, or point one `AUTH_SECRET` at a second
  database, and the holder stayed "signed in" as a user that did not exist —
  route protection passed, the UI rendered as authenticated, and the first
  write died on a foreign key as an unexplained 500 (reported against
  knowledge-base creation). The Node `jwt` callback now re-checks that the user
  row exists and returns `null` when it does not, which both nulls the session
  and clears the stale cookie. The check is throttled to once per
  `SESSION_REVALIDATE_SECONDS` (300) so ordinary requests add no query, and a
  failed lookup is treated as "unknown", never "deleted" — a database blip must
  not log everyone out.

## [0.20.0] - 2026-09-08

### Added

- **Agentic retrieval loop**
  ([spec 0029](specs/0029-agentic-retrieval-loop.md)), behind
  `RAG_AGENTIC_ENABLED` (default off). The model plans its own searches through
  a `search_documents` tool, resolves conversational references itself, and can
  search again when the first attempt is thin — inside hard caps on searches,
  wall-clock and tokens. Refusal remains a code path around the loop, never
  something the model is asked to honour. Citation verification strips claims
  their sources do not support. A separate query-rewriting call was built,
  measured at 15s, and folded into the planner instead. `step` frames report the
  current phase so the client is never silent without a heartbeat. The
  similarity floor rises with each extra search, because N attempts get N
  chances to clear it by luck — without that, refusal accuracy fell from 1.000
  to 0.667 while every other metric improved. `pnpm rag:eval --compare` scores
  both paths side by side and fails on a refusal regression.

- **Independent knowledge bases**
  ([spec 0028](specs/0028-independent-knowledge-bases.md)). A user can create,
  rename and delete several knowledge bases, upload a PDF into a chosen one, and
  move a document between them without re-ingesting it. A conversation searches
  a set of knowledge bases chosen when the thread is created, and cannot
  retrieve outside it — the filter sits beside `owner_id` in the same `WHERE`
  clause in all five places that clause appears, including the whole-document
  path where owner alone is no longer sufficient. `pnpm rag:eval` gains a
  cross-knowledge-base leakage metric (measured: 0) and fails the run on a
  refusal-accuracy regression against a saved baseline. Existing documents and
  conversations are migrated into one "My documents" knowledge base per user,
  with the backfill asserting its own correctness before it commits.

- **Rag Boilerplate: chat-first UX, conversation history and source viewing**
  ([spec 0026](specs/0026-chat-first-ux-and-history.md)). The product is now
  called Rag Boilerplate, signing in opens a new chat, and the shell uses the
  full viewport. Conversations and their citations persist and are listed as
  Recents in the sidebar, grouped by recency and renameable. Answers render as
  Markdown, show a thinking indicator until the first token, and carry
  generation metrics (tokens, tok/s, time to first token, model). Clicking a
  citation opens the source PDF at the cited page in a side panel.

### Removed

- **The `CI` and `CodeQL` GitHub Actions workflows.** No automated
  lint/typecheck/test/E2E run, and no container images published on a `v*` tag
  — which `deploy.yml` depended on. Run the quality gate locally before
  pushing. `docs/ci-cd.md` is kept as a record.

- **The `/dashboard` route.** It was a boilerplate demo page; chat is the
  landing surface now. Removed rather than redirected — a dead route still has
  to be maintained and tested.

- **RAG knowledge base and document chat** ([spec 0025](specs/0025-rag-knowledge-base-and-chat.md),
  [docs](docs/rag.md)). Upload PDFs into a private per-user knowledge base and
  ask questions answered only from your own documents, with a page-level
  citation for every source. Retrieval runs on `pgvector` inside the existing
  Postgres — no new service — and inference goes to any OpenAI-compatible
  endpoint (NVIDIA NIM by default, or a local Ollama/llama.cpp for a fully
  offline deployment). New `/documents` and `/chat` pages.

### Changed

- The `db` service image is now `pgvector/pgvector:pg17` (was
  `postgres:17-alpine`). The stock image does not ship the `vector` extension.
  Existing volumes keep working; the extension is created by migration `0008`.

## [0.19.0] - 2026-07-16

### Added

- **GitHub Releases are now generated by CI.** The `release` job creates the
  GitHub Release entry for every `v*` tag: notes come from that version's
  `CHANGELOG.md` section (falling back to auto-generated notes with a warning if
  the section is missing), and the title comes from the annotated tag's subject
  (`git tag -a vX.Y.Z -m "short title"` → "vX.Y.Z — short title"; lightweight
  tags get the bare version). Idempotent on job re-runs. The Releases page had
  silently frozen at v0.5.0 while tags marched on to v0.18.0 — those 27 missing
  entries were backfilled from the changelog, and this keeps it from drifting
  again.

## [0.18.0] - 2026-07-16

### Added

- **Floating `stable` image tag — "tag a release → the box deploys it".** The
  `release` job now also moves `ghcr.io/<owner>/<repo>:stable` (app + migrate) to
  every `v*` release it re-tags. A Tier B box that sets `APP_TAG="stable"`
  auto-deploys each new release within ~a minute of the tag push — the missing
  middle between `APP_TAG="latest"` (ships every green `main` merge) and a pinned
  semver (never moves without a manual bump on the box). Any `v*` push moves
  `stable`, so roll back by pinning `APP_TAG` to a previous version. With a
  floating tag, Settings → Build shows `stable · <sha7>` (the SHA still identifies
  the exact commit); pin a semver to display the version number.

## [0.17.0] - 2026-07-16

### Changed

- **Faster time-to-deploy (spec 0024).** A `v*` release tag no longer rebuilds the
  image — it **re-tags** the multi-arch image `main` already built and tested for
  that exact commit (`docker buildx imagetools create`, ~30s instead of a ~5.5 min
  rebuild). The `release` job waits for `main`'s `sha-<short>` image before
  re-tagging, so it inherits `main`'s full `quality` + `e2e` gate with no re-run.
  Tag CI drops from ~5m27s to ~30s.
- On `main`, the image build now **overlaps `e2e`**: `docker` is gated on `quality`
  only and runs in parallel with `e2e`, while `docker-merge` (which assigns the
  human tags) still needs both — so a failed test never yields a tagged image.
- The deployed version is now applied at **runtime** from `APP_TAG`
  (`APP_VERSION: ${APP_TAG}` on the `app` service in `docker-compose.deploy.yml`),
  since the re-tagged image keeps `main`'s baked `APP_VERSION`. `APP_GIT_SHA` stays
  baked. Settings → Build still shows `APP_TAG · <sha7>`.
- **Tier B pull timer** now defaults to a **60s** interval and **skips the deploy
  when the published app image is unchanged** (compares the pulled image digest to
  `~/.config/<repo>/.last-deployed-image`), so frequent polling is nearly free and a
  new release lands within ~a minute. Re-run `make deploy-timer` to pick up the new
  default on an existing box.

## [0.16.3] - 2026-07-16

### Fixed

- `make deploy` hung on some Podman machines: a single parallel
  `docker compose pull` (all services at once) wedges at 0% CPU on Podman, so the
  Tier B timer never completed a deploy. Now pulls the two GHCR images
  (`app`, `migrate`) individually, then `up -d`. This also stops re-checking the
  Docker Hub base images (postgres/minio/cloudflared) every run, avoiding Hub
  rate limits on a short timer interval. Found on the live self-hosted box; the
  individual-pull sequence was verified there end-to-end.

## [0.16.2] - 2026-07-16

### Fixed

- Deploy timer / autostart under launchd: the LaunchAgent ran with a bare `PATH`
  (`/usr/bin:/bin`) that omits Homebrew, so `docker` (at `/opt/homebrew/bin`)
  was unresolvable and every scheduled tick aborted at the readiness gate — even
  after the 0.16.1 probe fix. The install now **bakes the operator's `PATH` into
  the plist** and the scripts self-prepend the common Homebrew locations, so the
  engine resolves whether invoked from a shell or from launchd. Re-run
  `make deploy-timer` (or `make autostart`) to regenerate the plist. Found on the
  live self-hosted box.
- `scripts/setup.sh` preflight also switched from `docker info` to
  `docker version` (same Podman-hang avoidance).

## [0.16.1] - 2026-07-16

### Fixed

- Deploy timer / autostart: the container-engine readiness probe used
  `docker info`, which **hangs indefinitely on some Podman machines** — so every
  scheduled `make deploy-timer` tick (and `make autostart` boot) stalled before
  it ever deployed. Switched both to `docker version` (same reachability check,
  returns fast). Found on the live self-hosted box after 0.16.0.

## [0.16.0] - 2026-07-16

### Added

- **Deployed build version in Settings.** CI bakes the build identity
  (`APP_VERSION` = git ref, `APP_GIT_SHA` = commit) into the image via build-args;
  the app surfaces it in a new **Settings → Build** card, so you can confirm which
  version a self-hosted box is running after an unattended pull. Falls back to a
  "development build" note when unset (`next dev`, un-baked image).
  ([spec 0023](specs/0023-tier-b-default-and-build-version.md))
- **Pull-based deploy timer (Tier B).** `make deploy-timer`
  ([`scripts/macos-deploy-timer.sh`](scripts/macos-deploy-timer.sh)) installs a
  launchd timer that runs `make deploy` on an interval (default 300s), rolling out
  new releases unattended with **no self-hosted runner**.

### Changed

- **Pull-based deploy (Tier B) is now the recommended default**; the self-hosted
  runner path (Tier C) is documented as **private-repo-only**. On a public repo a
  fork pull request can execute arbitrary code on a self-hosted runner — Tier B
  (the box pulls from GHCR) has no such surface. `deploy.yml` now carries a loud
  do-not-use-on-public-repos warning.

### Security

- Documented and hardened against the **public-repo + self-hosted-runner** RCE
  risk (SECURITY.md, `deploy.yml`, Self-hosting → Tier C).

### Fixed

- Tier C self-hosted deploys: `deploy.yml` now copies the operator's `.env` from
  `~/.config/nextjs-fullstack-boilerplate/.env` (or `DEPLOY_ENV_FILE`) into the
  checkout before `make deploy` — `actions/checkout` cleans the work tree every
  run, so a `.env` in the checkout could never survive. Documented in
  Self-hosting → Tier C, along with the correct pinned-tag format
  (`APP_TAG=0.15.0`, no `v` — semver image tags are unprefixed).

## [0.15.0] - 2026-07-16

### Added

- **macOS boot persistence** (`make autostart`) — installs a login LaunchAgent
  ([`scripts/macos-autostart.sh`](scripts/macos-autostart.sh)) that waits for the
  Docker engine after a reboot and brings the tunnel stack up (`tunnel-up` by
  default, or `deploy` for pull-based updates). Closes the last gap between
  "deployed on a Mac mini" and "survives a power cut unattended".
- **Global per-IP login rate limit** (`AUTH_LIMITS.loginPerIp`, 50/10 min) —
  blunts credential stuffing across many accounts from one source. Enforced in
  both the login server action and the non-bypassable `authorize` callback,
  keyed independently so the two entry points don't double-count. Existing
  per-account (IP+email) limits unchanged.
- **"Running on a Mac mini (always-on)"** section in
  [Self-hosting](docs/self-hosting.md): autostart, auto-login/pmset, Docker
  Desktop vs OrbStack/Colima, memory sizing, and the Time Machine caveat
  (Docker volumes live in the VM and are NOT covered — offsite backups are the
  real safety net; also noted in [backups.md](docs/backups.md)).
- Unit tests for `getCurrentSession()` (decode-error tolerance, control-flow
  rethrow, genuine-failure rethrow) and the new per-IP login cap.

### Changed

- Renovate now pins GitHub Actions to commit digests
  (`helpers:pinGitHubActionDigests`).
- GitHub secret scanning + push protection enabled on the repository.

### Fixed

- Published container images are now **multi-arch** (`linux/amd64` +
  `linux/arm64`), so `make deploy` / `docker pull` works on Apple Silicon Mac
  minis and other ARM hosts — not just amd64 servers. CI builds each arch on its
  own native runner (`ubuntu-latest` + `ubuntu-24.04-arm`), pushes by digest, and
  merges a multi-arch manifest. The initial v0.14.0 images were amd64-only.
- Deployment-script hardening: `tunnel-verify.sh` uses `mktemp` instead of a
  fixed `/tmp` path and is shellcheck-clean; the setup wizard preflights
  `.env.example`; the quick-tunnel `cloudflared` gets `restart: unless-stopped`;
  the Terraform module README documents the provider v4→v5 upgrade caveat.

## [0.14.0] - 2026-07-16

### Added

- **One-click self-hosting** (`make setup`) — a guided wizard
  ([`scripts/setup.sh`](scripts/setup.sh)) that takes a fresh clone to a live app
  behind a Cloudflare Tunnel: preflight checks, `AUTH_SECRET` generation, a choice
  of quick / guided / automated on-ramp, demo-admin seeding, and a health verify.
  It orchestrates the existing tunnel primitives (spec 0005) rather than replacing
  them; idempotent and scriptable (non-interactive via env vars). New
  **[Self-hosting](docs/self-hosting.md)** guide and README pointer. See
  [spec 0020](specs/0020-one-click-self-hosting-setup.md).
- **`self-host` agent skill** for **Claude Code** (`.claude/skills/self-host/`) and
  **opencode** (`.opencode/skills/self-host/`) — auto-discovered when the project is
  opened, so you can tell your agent "self-host this on my domain" and it drives
  `make setup` (mode choice, Cloudflare inputs, run, verify) under the same
  secret-hygiene rules.
- **Continuous deployment for self-hosted instances** — CI now publishes the app +
  migrator images to GHCR (on `main`/tags, after tests pass), a
  `docker-compose.deploy.yml` overlay + `make deploy` pull and run them (migrations
  first, no build on the box), and an opt-in self-hosted-runner
  [`deploy.yml`](.github/workflows/deploy.yml) gives push-button deploys on release
  tags. Pull-based to respect the tunnel's outbound-only model. See
  [spec 0021](specs/0021-continuous-deployment-self-hosted.md) and
  [Self-hosting → Continuous deployment](docs/self-hosting.md#continuous-deployment).

## [0.13.6] - 2026-07-13

### Documentation

- Added a dedicated **[Web Push](docs/push.md)** guide (VAPID setup, subscribe/
  send, service-worker handlers, security), so every opt-in feature — OAuth,
  Email, Web Push, Backups — now has its own page. Linked from the README docs
  index and referenced from `pwa.md` / `features.md`.

## [0.13.5] - 2026-07-13

### Documentation

- Documentation review pass — corrected stale content, added a consolidated
  scripts reference, and tightened consistency:
  - **README** gains a full **Scripts** table (dev, quality, tests, database,
    docker, generators); refreshed the tech-stack and project-structure entries
    for OAuth / Web Push / theming / Mailpit.
  - **`docs/pwa.md`** — rewrote the "Push notifications" section, which still
    described the shipped feature as unbuilt to-do work.
  - **`docs/usage.md`** — added the missing env vars (OAuth, `APP_URL`,
    `REQUIRE_EMAIL_VERIFICATION`, `VAPID_*`, backup settings); fixed the
    `PROTECTED_PREFIXES` location (`proxy.ts`) and the stale "Add OAuth"
    extending row; expanded the testing/CI sections (Mailpit, per-test IP
    isolation, seed).
  - Consistency: standardized every doc's back-to-README link, aligned the
    email-provider list, fenced the deployment ASCII diagram as `text`, and
    fixed the "gitflow" → trunk-based wording in `specs/README.md`.

## [0.13.4] - 2026-07-13

### Added

- End-to-end email round-trips via a Mailpit catcher (`tests/e2e/email-flow.spec.ts`):
  register → emailed verification link → verified; and request reset → emailed
  link → new password → sign in with it. This closes the last manually-verified
  gap in spec 0011. A `mailpit` service is added to `docker-compose.yml`
  (`pnpm docker:mail`) and the CI e2e job; the e2e web server points at it
  (`playwright.config` / CI env). The round-trip tests self-skip when Mailpit
  isn't reachable, so a local run without it still passes the rest of the suite.
- Unit test for the email-disabled FR6 branch of `requestPasswordReset`
  (`tests/unit/recovery-actions.test.ts`), which the e2e suite can no longer
  cover now that it runs email-enabled.

## [0.13.3] - 2026-07-13

### Added

- Unit tests for the auth-recovery internals that were previously verified only
  by reading: `verification-tokens` (single-use consume, expiry rejection,
  hash-not-raw storage, purpose mismatch) and `verification-guard` (the
  `REQUIRE_EMAIL_VERIFICATION` soft-gate branches). +13 unit tests.

### Fixed

- Flaky E2E runs. Registration was rate-limited per **IP**, so every test shared
  one `register:::1` bucket that accumulated across the suite and tripped under
  CI retries. Each test now gets a unique client IP via `X-Forwarded-For`
  (`tests/e2e/fixtures.ts`), isolating rate-limit buckets so limits only fire
  in the test that provokes them. A Playwright `globalSetup` also seeds the demo
  admin (idempotent), making local runs self-healing if the dev DB was mutated.

## [0.13.2] - 2026-07-13

### Fixed

- OAuth users are now marked email-verified at creation. GitHub/Google verify
  email ownership before issuing their token, but the providers don't map
  `emailVerified`, so an OAuth account previously landed with
  `email_verified = null` — which meant `REQUIRE_EMAIL_VERIFICATION=true` would
  needlessly nag a provider-verified user with the verify banner and soft-gate
  their admin actions. `events.createUser` now sets `emailVerified` for
  adapter-created (OAuth) users. Credentials users are unaffected — they still
  verify via the emailed link. (Password reset was already correct: it only
  applies to accounts that have a password.)

## [0.13.1] - 2026-07-13

### Documentation

- Brought all docs current with the features shipped in 0.8.0–0.13.0 and added
  diagrams + setup guides:
  - **ERD** (Mermaid) of the full schema in [`docs/database.md`](docs/database.md),
    and a refreshed schema table (accounts/verification_tokens now in use;
    `push_subscriptions` added).
  - **ASCII container-topology diagram** of the production stack in
    [`docs/architecture.md`](docs/architecture.md); updated the overview diagram,
    auth-module table, and project tree for OAuth/email/push.
  - New **[OAuth setup guide](docs/oauth.md)** (GitHub + Google) and
    **[Email guide](docs/email.md)** (SMTP setup, password reset, verification,
    soft gate).
  - `README` "What it is" + Documentation index updated to link every guide.

## [0.13.0] - 2026-07-13

### Added

- Automated backups ([spec 0009](specs/0009-automated-backups.md)). The
  production compose stack gains a `db-backup` service (maintained
  `postgres-backup-local` image) writing nightly compressed Postgres dumps to
  `./backups/postgres/` with rolling retention (`BACKUP_RETENTION_DAYS`,
  default 14), and a `minio-backup` sidecar that `mc mirror`s the object bucket
  to `./backups/minio/` on an interval. A `scripts/backup-verify.sh` doctor
  script (mirrors `tunnel-verify.sh`) fails when the newest dump is stale or
  missing, so a silently-broken backup gets caught. Full restore runbook in
  [`docs/backups.md`](docs/backups.md), including an optional, opt-in offsite
  copy (e.g. Cloudflare R2). `backups/` is git- and docker-ignored (dumps
  contain user data).

## [0.12.0] - 2026-07-13

### Added

- Web Push notifications ([spec 0015](specs/0015-web-push-notifications.md)).
  Activates the push hooks that were stubbed in `public/sw.js` since the PWA
  work: a `push` handler that shows the notification and a `notificationclick`
  handler that focuses/opens the right tab. A new `push_subscriptions` table
  stores per-device subscriptions; Settings gains an "Enable notifications"
  toggle (permission prompt → `pushManager.subscribe` → `saveSubscription`
  server action, ownership-checked delete on disable). `sendPushNotification()`
  / `notifyRole()` server helpers send via `web-push` and auto-prune
  subscriptions the push service reports as Gone (HTTP 404/410). Wired
  end-to-end with one worked example — admins are notified when a new user
  self-registers. VAPID keys are opt-in env vars (`VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`); with none set the feature — including
  the Settings panel — is fully inert. The private key is server-only.

### Changed

- New `push_subscriptions` table (migration `0007_sticky_slyde`).

## [0.11.0] - 2026-07-13

### Added

- Email verification & password reset
  ([spec 0011](specs/0011-email-verification-password-reset.md)). Self-service
  password reset via `/forgot-password` → emailed single-use link (1-hour TTL)
  → `/reset-password`, with an anti-enumeration response (the same "if an
  account exists…" message regardless of whether the email is registered) and
  a "Forgot password?" link on the login form. Optional email verification:
  a verification email is sent on registration when email is enabled, confirmed
  at `/verify-email`. A new `REQUIRE_EMAIL_VERIFICATION` flag (default off, and
  ignored when email is disabled) soft-gates unverified users — a dismissible
  banner with a resend action, plus a server-side block on admin mutations —
  without locking them out of the app. The invite-token machinery was
  generalised from `invite.ts` into a shared `tokens.ts` primitive (same
  32-byte / SHA-256 / timing-safe design) now backing invites, reset, and
  verification; a `purpose` column on `verification_tokens` scopes each token
  so it can't be replayed cross-flow.

### Changed

- `verification_tokens` gains a nullable `purpose` column (migration
  `0006_daily_silver_fox`).

## [0.10.0] - 2026-07-13

### Added

- OAuth providers — GitHub & Google sign-in
  ([spec 0010](specs/0010-oauth-providers.md)). Wires the Auth.js Drizzle
  adapter into the Node auth config (the schema was already adapter-compatible)
  while keeping `session.strategy: 'jwt'`, so `proxy.ts`'s edge route
  protection still reads the JWT with zero DB round-trips. Each provider is
  independently opt-in via env vars (`AUTH_GITHUB_ID`/`_SECRET`,
  `AUTH_GOOGLE_ID`/`_SECRET`); with none set, nothing changes for
  credentials-only deployments. The login page shows "Continue with …" buttons
  only for configured providers. New OAuth users get a bootstrap role (first
  user → `admin`, rest → `member`) via `events.createUser`. Email-match
  auto-linking is **off** (an account-takeover vector): a matching email shows
  a "sign in and link from Settings" message instead. Settings gains a
  "Connected accounts" panel to link/unlink providers, with a server-side
  guard against unlinking your only remaining sign-in method.

## [0.9.1] - 2026-07-13

### Changed

- The app shell now shows the app icon (the same mark as the favicon/PWA icon)
  to the left of the wordmark in the sidebar, mobile drawer, and mobile topbar.
  The icon is decorative (`alt=""`) since the adjacent text already names the
  app. Rendered via `next/image` from `public/icon-192.png`.

## [0.9.0] - 2026-07-13

### Added

- SEO & OpenGraph metadata ([spec 0019](specs/0019-seo-opengraph-metadata.md)):
  shared links now unfurl to a rich preview card. Adds `metadataBase` plus
  `openGraph` and `twitter` (`summary_large_image`) blocks to the root layout,
  a default 1200×630 share image (`public/og.png`, generated by
  `pnpm gen:og` — swap the file to rebrand a fork, no code change), and
  `robots.txt` / `sitemap.xml` routes via Next's file conventions. A new
  optional `APP_URL` env var (defaults to `http://localhost:3000`) drives the
  canonical origin so image URLs resolve absolutely; set it to the real domain
  per deployment.

## [0.8.0] - 2026-07-13

### Added

- Dark-mode toggle & theming ([spec 0013](specs/0013-dark-mode-theming.md)):
  a light / dark / system theme switcher. The CSS token set (`.dark` oklch
  variables in `globals.css`) already existed but was unreachable — this wires
  up the switch. Powered by `next-themes` with `attribute="class"` and
  `defaultTheme="system"`, so it respects `prefers-color-scheme` until the user
  makes an explicit choice, which then persists in `localStorage`. The
  anti-flash inline script runs under the strict production CSP via the existing
  per-request nonce (threaded from `proxy.ts` through the root layout) — no
  `script-src` loosening. A `lucide-react` sun/moon dropdown lives in the app
  shell topbar and on the login/register pages, so authenticated and
  unauthenticated users can both pick a theme. The trigger icon swaps purely via
  CSS to avoid any flash-of-wrong-icon or hydration mismatch.

## [0.7.2] - 2026-07-13

### Fixed

- Profile photos no longer flash the fallback initials on every page refresh.
  Two causes: the download route sent `Cache-Control: no-store` for all files
  (so the avatar was re-fetched over the network on every load), and Radix's
  `Avatar` shows the fallback until the `<img>` finishes loading. Avatars are
  now served `private, max-age=…, immutable` — safe because each avatar has a
  unique, immutable URL (a fresh file id on every change; the old one is
  deleted) — while general file downloads keep the stricter `no-store`. The
  `AvatarFallback` also gets a short `delayMs` when a photo is expected, so a
  fast/cached load renders the image directly instead of briefly flashing
  initials.

## [0.7.1] - 2026-07-13

### Fixed

- File downloads (`GET /api/files/[id]`) 500'd when the original filename
  contained a character above U+00FF — e.g. the U+202F narrow no-break space
  macOS puts in screenshot names (`Screenshot … 12.01.47 pm.png`). HTTP
  header values are ByteStrings, so the raw name in the `Content-Disposition`
  `filename="…"` fallback threw. The fallback is now stripped to printable
  ASCII; the RFC 5987 `filename*=UTF-8''…` parameter (already present)
  carries the real Unicode name for modern browsers. Existing avatars/files
  affected by this display correctly on the next request — no re-upload
  needed. Regression-tested with a macOS-screenshot-style filename.

## [0.7.0] - 2026-07-13

### Added

- Profile photo upload ([spec 0018](specs/0018-profile-photo-upload.md)):
  every signed-in user can upload/replace/remove their own avatar from
  Settings, built entirely on the file-storage infrastructure from
  [0007](specs/0007-file-uploads.md). Narrower size/type limits than general
  uploads; counts against the same per-user quota. Surfaced through Auth.js's
  standard `session.user.image` — shows in the app shell topbar and Settings
  immediately, no re-login required. `users` gains a nullable
  `avatar_file_id` column (FK → `files.id`, `set null`).
- shadcn `Avatar` component (`src/components/ui/avatar.tsx`).

### Fixed

- `useSession().update()` called with no argument only re-fetches the
  current session — it never reruns the `jwt` callback's
  `trigger === 'update'` branch, so client-triggered session refreshes
  (e.g. after a profile-photo change) silently did nothing. Fixed by calling
  `update({})`; documented in `CLAUDE.md` since it's easy to get wrong again.
- `AvatarFallback`'s default styling (`bg-muted`/`text-muted-foreground`,
  shadcn's own default) failed WCAG AA contrast at small sizes — caught by
  the existing a11y test suite, fixed by switching to `text-foreground`.

## [0.6.0] - 2026-07-13

### Added

- File uploads & object storage ([spec 0007](specs/0007-file-uploads.md)):
  self-hosted, S3-compatible **MinIO** as a docker-compose service (no public
  ingress — the app is the only gateway to it), a `files` table, and
  `src/lib/storage/` (upload/list/delete Server Actions, an
  ownership-checked `GET /api/files/[id]` download route). Uploads are
  validated server-side against a size cap, a MIME-type allow-list, and a
  per-user storage quota, and are rate-limited. A "My Files" panel in
  Settings is available to every signed-in user. Deleting a user now also
  deletes their stored files and objects.
- `pnpm docker:minio` — brings up MinIO plus a one-shot bucket-init service,
  alongside the existing `pnpm docker:db`.

### Fixed

- Server Actions now return `{ ok, error }` results instead of throwing for
  expected/validation failures (`src/lib/storage/actions.ts`) — Next.js
  redacts thrown error messages in production builds, which silently broke
  user-facing validation messages. Caught by testing against the actual
  production Docker image, not just `next dev`.

## [0.5.2] - 2026-07-13

### Added

- Specs for the next phase of the roadmap: file uploads & object storage
  ([0007](specs/0007-file-uploads.md)), automated backups
  ([0009](specs/0009-automated-backups.md)), OAuth providers
  ([0010](specs/0010-oauth-providers.md)), email verification & password
  reset ([0011](specs/0011-email-verification-password-reset.md)), dark-mode
  theming ([0013](specs/0013-dark-mode-theming.md)), Web Push
  ([0015](specs/0015-web-push-notifications.md)), and a written-but-not-
  scheduled note on shared-store rate limiting
  ([0017](specs/0017-shared-store-rate-limiting.md)).

### Changed

- Condensed the README roadmap checklist; it now points at `specs/` for
  detail instead of carrying per-item prose.
- Simplified the branch strategy to trunk-based: `main` is the only
  long-lived branch (no `develop`). Feature branches go `main` → `feature/*`
  → `main`; CI/CodeQL triggers updated to match.

## [0.5.1] - 2026-07-13

### Added

- Automated accessibility regression checks (`tests/e2e/a11y.spec.ts`) — axe
  (`@axe-core/playwright`) scans of login, register, dashboard, the settings
  admin panel (incl. the "Add User" dialog), and `/403` against WCAG 2.0/2.1
  A + AA, so an a11y regression fails CI instead of relying on a one-time
  manual pass.
- Unit test coverage for `src/lib/auth/admin-actions.ts` (previously 0%,
  the largest untested surface in the app) — create/update/delete user,
  role assignment, and invite completion, including the self-role-removal,
  self-delete, duplicate-email, and unknown-role guard paths.

### Changed

- Roadmap reframed around forking this boilerplate per POC/portfolio project
  and self-hosting a single instance (Docker + Cloudflare Tunnel), not scaling
  out across a cluster. Cloudflare Tunnel deployment is now marked shipped;
  file uploads (MinIO), SEO/public-facing metadata, and automated backups are
  the near-term priorities; shared-store rate limiting is deprioritized.

## [0.5.0] - 2026-07-13

### Added

- Role-based access control ([spec 0006](specs/0006-rbac.md)): `roles` / `user_roles`
  tables, roles in the JWT session, `requireRole` / `hasRole` server guards and
  `useRole` / `<RequireRole>` client helpers, edge role-gating in `proxy.ts`, a `/403`
  page, and an admin user-management panel in Settings.
- Invite-only account claim: admin-created users are passwordless and can only be
  claimed with a single-use, hashed, 7-day invite token via `/register?invite=…`.
- Optional email delivery (`src/lib/email/`): SMTP-based, provider-agnostic, and
  **off by default**. It activates only when `EMAIL_ENABLED=true` **and** an SMTP
  provider is configured — enabling it without a provider fails fast at boot, and
  when disabled every send is a safe no-op. Invite links are emailed when enabled and
  always shown in the admin UI as a fallback.

### Changed

- CI and CodeQL now run on `develop` as well as `main`, so feature PRs into the
  integration branch are gated by the full pipeline.

## [0.4.1] - 2026-07-12

### Changed

- Expanded the deployment guide ([docs/deployment.md](docs/deployment.md)) with a
  how-it-works overview, an environment-variables table, and operating /
  troubleshooting sections; added a prominent Deployment section to the README.

## [0.4.0] - 2026-07-12

### Added

- Cloudflare Tunnel deployment ([spec 0005](specs/0005-cloudflare-tunnel-deployment.md)):
  quick-tunnel and named-tunnel Compose overlays, a Terraform module
  (`infra/cloudflare/`), a `Makefile`, `docs/deployment.md`, and a
  `tunnel-verify` doctor. Rate limiting now trusts `CF-Connecting-IP`.
- Spec-driven development: a `specs/` directory with a template, workflow guide,
  and one spec per release.

## [0.3.1] - 2026-07-12

### Added

- `CLAUDE.md` with repo context, conventions, and a gitflow/commit guide for AI
  assistants working in this repository.
- graphify integration for Claude Code (`.claude/settings.json` PreToolUse
  hooks) that queries the knowledge graph before browsing source.

## [0.3.0] - 2026-07-12

### Added

- Auth rate limiting on login and registration — enforced in the server actions
  and, non-bypassably, in the credentials `authorize` callback.
- Nonce-based Content-Security-Policy with `strict-dynamic`, HSTS, and
  `X-Powered-By` disabled.
- Case-insensitive `lower(email)` unique index (defense in depth).
- Accessible mobile drawer: focus trap, Escape to close, focus restore, and a
  skip-to-content link.
- Structured-logging shim and graceful database-pool shutdown on SIGTERM.
- Renovate, CodeQL, commitlint (Conventional Commits), and a CI dependency audit.
- Contributor docs: CONTRIBUTING, SECURITY, and issue/PR templates.
- Tests for auth error paths and rate limiting.

### Changed

- `getCurrentSession` now treats only undecryptable cookies as signed-out;
  genuine errors surface instead of being swallowed.
- Registration relies on the unique constraint (handles the duplicate-signup
  race) and returns a clean error.
- Documentation expanded with a security model and session-revocation notes.

### Fixed

- Service worker no longer reloads on its initial claim (fixed a sign-out race).

## [0.2.0] - 2026-07-11

### Added

- Progressive Web App: web manifest, generated icons, a service worker with
  auth-safe caching, an offline fallback, and an install prompt.
- Minimal, borderless responsive app shell (sidebar + topbar with a mobile
  drawer) with PWA safe-area handling.
- MIT license.

### Fixed

- Resilient session handling and error boundaries (`error.tsx`,
  `global-error.tsx`, `not-found.tsx`) — resolves a Next.js 16 Turbopack
  global-error crash.

### Changed

- README restructured into a `docs/` directory.

## [0.1.0] - 2026-07-11

### Added

- Initial production-grade Next.js 16 boilerplate: App Router, Auth.js v5
  credentials auth (Argon2id, JWT sessions), Drizzle ORM + PostgreSQL,
  Tailwind CSS v4 + shadcn/ui, Vitest + Playwright, a multi-stage Docker image,
  and a GitHub Actions CI pipeline.

[Unreleased]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.7.2...HEAD
[0.7.2]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/releases/tag/v0.1.0
