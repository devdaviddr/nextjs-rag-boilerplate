# CI/CD

[← Back to README](../README.md)

**What this covers:** what runs in GitHub Actions on every pull request, merge
and release tag, how a merge becomes a published image, and the checks you can
run locally before pushing.

If what you want is to ship a change, read [Feature → Production](workflow.md)
instead — it is the ordered path, and this page is the reference behind it.

## The workflows

Three workflows live in `.github/workflows/`. `ci.yml` runs on every push and
pull request to `main` and on `v*` tags; `pr.yml` checks each pull request
against the contribution process; `deploy.yml` is opt-in and only runs on
release tags.

```
┌─────────────────────────────────────────────────────────────┐
│ .github/workflows/ci.yml  (push / PR → main · v* tags)      │
├─────────────────────────────────────────────────────────────┤
│ On push to main / PR (NOT tags):                             │
│   quality : format:check · lint · typecheck · test:coverage  │
│             · specs:check · pnpm audit (non-blocking)        │
│   e2e     : Postgres service + MinIO + Mailpit → migrate/seed │
│             → build → Playwright (uploads report artifact)   │
│   docker  : needs quality; builds in PARALLEL with e2e;      │
│             per-arch native (amd64 + arm64) → push by digest  │
│   docker-merge : needs docker + e2e; assemble multi-arch     │
│             manifest → publish 2 GHCR images (app + migrate); │
│             PRs build only (no push, no merge)               │
│ On a v* release tag (fast path — no rebuild):                │
│   release : release:check, then wait for main's already-built │
│             image for this commit and re-tag it with the     │
│             semver + stable (~30s). See "Release fast-path". │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ .github/workflows/pr.yml  (PR → main · edits and labels)     │
├─────────────────────────────────────────────────────────────┤
│ process : commitlint on every PR commit and the title ·      │
│           pr:check (linked issue, CHANGELOG entry)           │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ .github/workflows/deploy.yml  (release tags · opt-in)       │
├─────────────────────────────────────────────────────────────┤
│ deploy  : `make deploy` on a self-hosted runner, gated by    │
│           vars.SELF_HOSTED_DEPLOY (off by default)           │
└─────────────────────────────────────────────────────────────┘
```

The interesting part of that layout is the gating. `quality` and `e2e` run
independently. **`docker` is gated on `quality` only** (fast lint/type/unit) so
the ~2–3 min image build **overlaps** the ~2 min `e2e` instead of queuing
behind it. But **`docker-merge` — the job that assigns the human-readable tags —
needs both `docker` and `e2e`**, so nothing gets a usable tag until the full
suite is green. Fast where it is safe to be fast, strict where it matters.

There is no CodeQL workflow. It was removed while the repository was private
and code scanning was unavailable; restoring it is a separate decision.

### Shared setup

All jobs run on `ubuntu-latest` with **Node 22** (no version matrix) and pnpm
via `pnpm/action-setup`, taking the version from `package.json`'s
`packageManager` field rather than pinning it in the workflow. Next.js telemetry
is disabled with `NEXT_TELEMETRY_DISABLED` for reproducible builds.

`ci.yml` sets `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress:
true }`. Pushing again to the same branch or PR cancels whatever run is already
in flight — if a run vanishes from the Actions tab after a follow-up push, that
is this setting, not a failure.

### `quality` job

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm specs:check
pnpm audit --audit-level=high   # continue-on-error: advisory, non-blocking
```

### `e2e` job

Postgres runs as a GitHub Actions `services:` container using
**`pgvector/pgvector:pg17`** — the RAG migration needs the `vector` extension,
so a stock `postgres` image will not do — health-checked.

MinIO and Mailpit **cannot** be `services:` containers. That block supports
only `image`/`env`/`ports`, and MinIO needs a `server /data` command to start
at all. The workflow starts both explicitly with `docker run` and polls their
health endpoints, mirroring `docker-compose.yml`. The bucket is `app-files`,
created with the MinIO client. Both MinIO images are the Chainguard builds
(`cgr.dev/chainguard/minio` and `minio-client`, `-dev` tags) because
`minio/minio` and `minio/mc` no longer pull
([#18](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/18)).

The job then runs `pnpm db:migrate` → `pnpm db:seed` → `pnpm build` →
`pnpm exec playwright install --with-deps chromium` → `pnpm test:e2e`, and
uploads `playwright-report/` as an artifact (`if: ${{ !cancelled() }}`, 7-day
retention). Email is enabled against Mailpit (`EMAIL_ENABLED=true`,
`SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`) so the reset and verification
round-trips in `email-flow.spec.ts` actually run. `AUTH_SECRET` is a throwaway
CI value.

**The RAG suites always skip in CI.** `rag.spec.ts`, `knowledge-bases.spec.ts`
and the inference-dependent tests in `chat.spec.ts` self-skip without
`NVIDIA_API_KEY`, and the E2E step sets it to an empty string on purpose: they
call the rate-limited NIM endpoint, so they are not run on every PR. A
repository secret of that name has no effect. Run them locally, with the key in
`.env`, before merging a change to retrieval, ingestion or chat:

```bash
pnpm test:e2e tests/e2e/rag.spec.ts tests/e2e/knowledge-bases.spec.ts tests/e2e/chat.spec.ts
```

**Test isolation.** Each E2E test uses a unique client IP (via
`CF-Connecting-IP`) so rate-limit buckets do not leak between tests — that is
what makes a parallel suite reproducible, and it also means the rate-limit tests
assert something real. Implementation: `tests/e2e/fixtures.ts`.

### `docker` job (+ `docker-merge`, `release`)

`docker` is gated `needs: [quality]` and runs in **parallel** with `e2e`;
`docker-merge` is gated `needs: [docker, e2e]`, so only tested images are
published. Images are **multi-arch** (`linux/amd64` + `linux/arm64`) so they run
on Apple Silicon Mac minis as well as amd64 servers. To avoid slow QEMU
emulation, `docker` is a matrix that builds each architecture on its **own
native runner** (`ubuntu-latest` + `ubuntu-24.04-arm`) and pushes by digest;
`docker-merge` then assembles the per-arch digests into one manifest per image
via `docker/metadata-action`.

Two images, because one cannot do both jobs:

- `ghcr.io/<owner>/<repo>` — the production `runner` target (the app).
- `ghcr.io/<owner>/<repo>/migrate` — the `builder` target, the only one that can
  run `pnpm db:migrate` (the runner standalone image has no tsx and no source).

Tags: the commit `sha`, the branch, semver on `v*` tags, and `latest` on the
default branch. **Pull requests build both arches cache-only and never push**
(login is skipped, and `docker-merge` is gated to non-PR runs) so forks stay
safe. It uses the workflow `GITHUB_TOKEN` with `packages: write`.

**Build identity.** The `main`/PR app build bakes in
`APP_VERSION=${{ github.ref_name }}` (so `main` on a branch build) and
`APP_GIT_SHA=${{ github.sha }}` as build-args. The Dockerfile persists them as
`ENV` and `src/lib/env.ts` reads them. Because a release tag **re-tags this
image rather than rebuilding it** (below), the baked `APP_VERSION` stays `main`;
the deployed version is instead applied at **runtime** from the pinned
`APP_TAG` (`docker-compose.deploy.yml`), while `APP_GIT_SHA` stays baked and
correct. Either way the app surfaces the pair in **Settings → Build**, so an
operator can confirm which version a self-hosted box is running.

On a tag ref, `docker` and `docker-merge` are skipped and the `release` job
re-tags instead.

### `pr.yml` — PR checks

A separate workflow so that editing a PR's title or description, or changing a
label, re-runs it in seconds without re-running the build and E2E suite. One
job, **PR checks**:

- `commitlint` over every commit in the PR (`--from base --to head`) and over
  the PR title, with the same `@commitlint/config-conventional` rules as the
  local `commit-msg` hook.
- `pnpm pr:check` (`scripts/pr-check.mjs`): the body must link an issue with
  `Closes #N`, `Fixes #N`, `Resolves #N` or `Part of #N` (bots exempt), and a
  `feat`, `fix`, `perf`, `revert` or breaking PR must change `CHANGELOG.md`
  unless it carries the `no-changelog` label.

The title, body and labels reach the scripts through `env:`, never through
`${{ }}` interpolation inside `run:` — on a fork PR they are attacker-controlled.
The rules themselves are pure functions in `scripts/process-rules.mjs`, tested
in `tests/unit/process-rules.test.ts`.

### Required checks

A repository ruleset on `main` requires a pull request and these checks to
pass before merge: **Lint · Typecheck · Unit**, **E2E (Playwright)** and
**PR checks**. Nothing reaches `main` without them, including release commits.

### Dependency updates and security scanning

**Renovate** (`renovate.json`) opens dependency PRs every Monday before 6am:
non-major updates grouped into one PR, majors one at a time with a `major`
label, lock-file maintenance monthly, and security fixes as soon as an advisory
lands (labelled `security`). It also keeps the pinned image digests in the
compose files and CI current, and pins GitHub Actions to digests. Its PRs are
labelled `dependencies` and `no-changelog` — the PR checks exempt bots from the
linked-issue rule, and the release summarises dependency updates in one
CHANGELOG line rather than one per bump. The Dependency Dashboard issue lists
everything pending.

**Secret scanning with push protection** is on: a push that contains a
recognised credential is rejected before it reaches GitHub. **Dependabot
alerts** are on for the Security tab; Dependabot's own update PRs are off so
they don't duplicate Renovate's.

## Release fast-path

A release is a `v*` tag placed on a `main` commit that CI **already built,
tested, and published** (as `sha-<short>` + `latest`) minutes earlier.
Rebuilding on the tag would recompile a bit-identical image just to add the
semver tag — the slowest thing on the whole tag→live path. So on a tag ref the
workflow runs a single `release` job that **adds the semver tag — and moves the
floating `stable` tag — on the existing multi-arch digest** with
`docker buildx imagetools create` (a manifest operation, ~30s). `quality`,
`e2e`, `docker` and `docker-merge` are all skipped.

Before any of that, the job runs `scripts/release-check.mjs --tag vX.Y.Z`. It
fails the release — so nothing is re-tagged — when `package.json`, the
`CHANGELOG.md` heading and the tag name different versions, when
`[Unreleased]` still has entries, when the version is not higher than every
earlier tag, or when a spec with every acceptance criterion ticked is still
`Proposed`. `pnpm release:check` runs the same check locally before you tag.

Skipping the tests on a tag sounds unsafe. It is not, because of a wait. The
`release` job **waits** for `ghcr.io/<owner>/<repo>:sha-<short>` (app + migrate)
to exist before re-tagging, so it **inherits `main`'s full gate** — that image
is only published once `main`'s `quality` + `e2e` + build pass. If it never
appears, the release fails loudly rather than shipping something untested.

**`stable` always points at the most recently released image.** That is the tag
a Tier B box sets `APP_TAG` to for automatic _release-only_ deploys: `latest`
moves on every `main` merge, a pinned semver never moves, and `stable` moves
exactly when a release is cut. Any `v*` push moves it — including an old tag
re-pushed — so the correct rollback is to pin `APP_TAG` to a semver, not to
re-push an old tag.

The `release` job also **creates the GitHub Release entry**, so the Releases
page never drifts from the tags. The notes are that version's `CHANGELOG.md`
section, and the title comes from the annotated tag's subject
(`git tag -a vX.Y.Z -m "short title"` → "vX.Y.Z — short title"; a lightweight
tag gets the bare version). Re-runs skip an existing release.

Because the re-tagged image carries `main`'s baked `APP_VERSION=main`, the
deployed version is applied at **runtime** from the tag the box pulled —
`APP_VERSION: ${APP_TAG}` on the `app` service in `docker-compose.deploy.yml`
(with `APP_GIT_SHA` still baked, correct). Settings → Build shows
`APP_TAG · <sha7>` — with a floating `APP_TAG=stable` that reads
`stable · <sha7>`, and the SHA still pins the exact commit; pin a semver if you
want the version number displayed. See
[spec 0024](../specs/0024-faster-time-to-deploy.md).

> **Realizing the win:** merge to `main`, let `main` CI go green, **then** push
> the `v*` tag — the image is already there and the tag ships in ~30s. Pushing
> the tag at the same time as the merge is still correct: the `release` job
> just waits for `main`'s build (no duplicate compute), then re-tags.

### Measured: the time-to-deploy budget

Measured on the `v0.16.x` releases, with the box pinning a semver `APP_TAG` so
the tag pipeline sits on the critical path:

| Phase                                 | Before (0.16.x)       | After (0.17.0)                       |
| ------------------------------------- | --------------------- | ------------------------------------ |
| Tag CI (`git push` tag → image ready) | ~5m27s (full rebuild) | ~30s re-tag¹                         |
| Poll wait (Tier B timer)              | 0–300s (avg ~150s)    | 0–60s (avg ~30s), idle ticks skipped |
| Deploy on box                         | ~1–2 min              | ~1–2 min (unchanged)                 |

¹ Plus a wait for `main`'s build if the tag is pushed before `main` CI is green.
The `main` build itself (~3–4 min after overlapping build with e2e) is the one
unavoidable compile of new source.

## How a merge becomes a live deploy

1. A PR merges to `main`.
2. `ci.yml` runs `quality` and `e2e` in parallel; `docker` starts as soon as
   `quality` is green (it does not wait on `e2e`) and builds both
   architectures.
3. Once **both** `docker` and `e2e` are green, `docker-merge` assembles the
   multi-arch manifests and publishes `ghcr.io/<owner>/<repo>` (app) and
   `ghcr.io/<owner>/<repo>/migrate`, tagged `sha-<short>` and `latest`.
4. When you are ready to cut a release: bump the version, update
   `CHANGELOG.md`, and push a `vX.Y.Z` tag on that same commit (see
   [Feature → Production § 5](workflow.md#5--cut-a-release)).
5. The tag triggers `ci.yml`'s `release` job, which **waits** for step 3's
   `sha-<short>` image to exist, then re-tags it with the semver, moves the
   floating `stable` tag (~30s, no rebuild) and creates the GitHub Release.
6. A box tracking `APP_TAG=stable` (the recommended default — see
   [Self-hosting → Tier B](self-hosting.md#tier-b-recommended--pull-with-make-deploy))
   picks up the new digest on its next `make deploy-timer` tick (≤60s) and runs
   `make deploy`: pull → migrate → restart. Nothing is pushed to the box — it is
   outbound-only the whole way.

## `deploy.yml`

`deploy.yml` listens for `v*` tags (and a manual **Run workflow** button) and
runs `make deploy` on a **self-hosted runner** on your own box — pull the
published images, migrate, restart. The runner dials out to GitHub, so it works
behind a tunnel with no inbound ports.

It is **skipped unless the repository variable `SELF_HOSTED_DEPLOY == 'true'`**,
and it is unset here. 🚫 **Do not enable it on a public repository.** A
self-hosted runner on a public repo is the configuration GitHub explicitly
warns against: a fork pull request can add a workflow targeting
`runs-on: [self-hosted]` and, once approved, execute arbitrary code on your box
and home network. The `SELF_HOSTED_DEPLOY` gate does not help — a malicious fork
brings its own workflow file. Use the pull-based **Tier B** deploy
(`make deploy-timer`) instead: no runner, no such surface. Full reasoning and the
recommended alternative are in
[Self-hosting → Continuous deployment](self-hosting.md#continuous-deployment).

## Run the checks locally

CI runs the gate, but it should never be the only place a check can run. Before
pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

For the full browser suite as well, start the local dependencies first:

```bash
pnpm docker:db && pnpm docker:minio && pnpm docker:mail && \
  pnpm db:migrate && pnpm db:seed && pnpm build && pnpm test:e2e
```

What each of those scripts does, what the unit and E2E suites actually cover,
and the rule about running E2E with `--workers=1` when
`RAG_AGENTIC_ENABLED=true` all live in
[Usage & Development → Testing](usage.md#testing). The pre-deployment list lives
in [Usage & Development → Production checklist](usage.md#production-checklist).

Locally, Husky runs `lint-staged` (ESLint + Prettier) over staged files on every
`git commit`, and commitlint checks the message. Both are installed by the
`prepare` script when you `pnpm install`.

Aim for **unit-test coverage above 80%** (`pnpm test:coverage` reports it), and
verify a **restore**, not only a backup, before you call a deployment
production-ready — see [Backups & restore](backups.md).

## Adding a check

1. Put it in the `quality` job. It is the fast, blocking one, next to
   `format:check` / `lint` / `typecheck` / `test:coverage` / `specs:check`.
2. If a check is exploratory or has a high false-positive rate — as
   `pnpm audit` does — mark the step `continue-on-error: true` so it reports
   without blocking merges, rather than leaving it out entirely.
3. Expose it as a `pnpm` script in `package.json` so a contributor can run it
   locally before pushing.
4. If the check belongs in the standard gate, update the pre-push command
   (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`) here, in
   [Usage & Development](usage.md), in `README.md` and in `CONTRIBUTING.md`.
5. Pin one Node version (22) rather than a matrix, and bump it deliberately when
   you upgrade.

## Troubleshooting

Deploy-time symptoms — 502 Bad Gateway, a login loop, the wrong client IP, a
stale `.env` — are owned by
[Self-hosting → Troubleshooting](self-hosting.md#troubleshooting).

Failures specific to running the suite:

- **Rate-limit leakage between tests.** Check that each test is getting a unique
  client IP from `tests/e2e/fixtures.ts`; a shared IP makes tests interfere.
- **Compose health checks not ready.** The dependency containers are slower than
  the test runner on a cold start. Give them longer, or read their logs.
- **`release:check` fails on a tag.** The tagged commit is not a finished
  release. Delete the tag (`git push --delete origin vX.Y.Z`), fix it in a PR,
  and tag the new merge commit.
- **A `release` job times out waiting for `sha-<short>`.** `main`'s run for that
  commit failed or has not finished. Get `main` green, then re-run the job.

```bash
# Container logs, following:
docker compose logs -f

# Apply pending database migrations:
pnpm db:migrate

# MinIO status (Chainguard client image, see #18):
docker run --rm --network host --entrypoint /bin/sh \
  cgr.dev/chainguard/minio-client:latest-dev \
  -c "mc alias set local http://localhost:9000 minioadmin minioadmin && mc admin info local"
```

Routine maintenance chores live with their owners: the migration workflow (edit
`src/db/schema.ts` → `pnpm db:generate` → review → commit → `pnpm db:migrate`)
in [Database](database.md), the generated assets (`pnpm gen:icons`,
`pnpm gen:og`) in [Usage & Development → Scripts](usage.md#scripts), and the
rule that every new environment variable goes into both `src/lib/env.ts` and
`.env.example` in
[Usage & Development → Environment variables](usage.md#environment-variables).

---

**Next:** [specs/README.md](../specs/README.md) — the numbered design specs
behind everything in these docs, including
[spec 0024](../specs/0024-faster-time-to-deploy.md), which is where the release
fast-path above was designed.
