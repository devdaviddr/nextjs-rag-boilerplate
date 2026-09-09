# CI/CD

[← Back to README](../README.md)

**What this covers:** why this fork has no automated pipeline, what you run in
its place, and — kept as an honest record — exactly what the old GitHub Actions
pipeline did, in case you want it back.

> ## There is no CI in this fork
>
> The `CI` and `CodeQL` workflows were **deleted**. Nothing runs lint,
> typecheck, unit tests or E2E tests when you push. Nothing builds or publishes
> a container image on a merge or on a release tag.
>
> **You are the pipeline.** Run this before every push:
>
> ```bash
> pnpm lint && pnpm typecheck && pnpm test && pnpm build
> ```
>
> One workflow survives — `deploy.yml` — and it is off by default. See
> [What is still in `.github/workflows/`](#what-is-still-in-githubworkflows).

If what you want is to ship a change, read
[Feature → Production](workflow.md) instead. The two sections below are what
still applies today; everything after **The record** describes something that no
longer runs.

## Run the gates yourself

There are two layers of protection left, and both are local.

**The pre-commit hook.** Husky runs `lint-staged` (ESLint + Prettier) over your
staged files on every `git commit`. It is installed automatically by the
`prepare` script when you `pnpm install`. It only sees files you staged, so it
catches formatting, not a broken build.

**The pre-push command.** This is the real gate, and nothing runs it for you:

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
[Usage & Development → Testing](usage.md#testing), which owns that detail. The
pre-deployment list lives in
[Usage & Development → Production checklist](usage.md#production-checklist).

Two habits carried over from the pipeline era and still worth keeping: aim for
**unit-test coverage above 80%** (`pnpm test:coverage` reports it), and verify a
**restore**, not only a backup, before you call a deployment production-ready —
see [Backups & restore](backups.md).

## What is still in `.github/workflows/`

One file: `deploy.yml`. It listens for `v*` tags (and a manual **Run workflow**
button) and runs `make deploy` on a **self-hosted runner** on your own box —
pull the published images, migrate, restart. The runner dials out to GitHub, so
it works behind a tunnel with no inbound ports.

It is **skipped unless the repository variable `SELF_HOSTED_DEPLOY == 'true'`**,
and it is `false`. Two things to know before you consider turning it on:

1. It deploys images that `ci.yml` used to build. With `ci.yml` gone, **a `v*`
   tag produces no image for it to pull.** Restore an image-publishing job (or
   build and push the two images by hand) first.
2. 🚫 **Do not enable it on a public repository.** A self-hosted runner on a
   public repo is the configuration GitHub explicitly warns against: a fork
   pull request can add a workflow targeting `runs-on: [self-hosted]` and, once
   approved, execute arbitrary code on your box and home network. The
   `SELF_HOSTED_DEPLOY` gate does not help — a malicious fork brings its own
   workflow file. Use the pull-based **Tier B** deploy (`make deploy-timer`)
   instead: no runner, no such surface. Full reasoning and the recommended
   alternative are in
   [Self-hosting → Continuous deployment](self-hosting.md#continuous-deployment).

---

## The record — everything below here no longer runs

The rest of this page describes workflows that are **no longer in the
repository**. It is kept for two reasons: the design decisions in it —
especially the release fast-path — are the starting point if you restore the
pipeline, and the measured numbers explain why the deploy path is shaped the way
it is. It is written in the past tense throughout. You can stop reading here and
still ship changes.

## The record: the three workflows

`ci.yml` and `codeql.yml` ran on every push and pull request to `main`;
`deploy.yml` was opt-in and only ran on release tags.

```
┌─────────────────────────────────────────────────────────────┐
│ .github/workflows/ci.yml  (push / PR → main · v* tags)      │
├─────────────────────────────────────────────────────────────┤
│ On push to main / PR (NOT tags):                             │
│   quality : format:check · lint · typecheck · test:coverage  │
│             · pnpm audit (non-blocking)                      │
│   e2e     : Postgres service + MinIO + Mailpit → migrate/seed │
│             → build → Playwright (uploads report artifact)   │
│   docker  : needs quality; builds in PARALLEL with e2e;      │
│             per-arch native (amd64 + arm64) → push by digest  │
│   docker-merge : needs docker + e2e; assemble multi-arch     │
│             manifest → publish 2 GHCR images (app + migrate); │
│             PRs build only (no push, no merge)               │
│ On a v* release tag (fast path — no rebuild):                │
│   release : wait for main's already-built image for this     │
│             commit, then re-tag it with the semver + stable  │
│             (~30s). See "Release fast-path" below.           │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ .github/workflows/codeql.yml  (push / PR → main · weekly)   │
├─────────────────────────────────────────────────────────────┤
│ analyze : CodeQL security-and-quality (javascript-typescript)│
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ .github/workflows/deploy.yml  (release tags · opt-in)       │
├─────────────────────────────────────────────────────────────┤
│ deploy  : `make deploy` on a self-hosted runner, gated by    │
│           vars.SELF_HOSTED_DEPLOY (off by default)           │
└─────────────────────────────────────────────────────────────┘
```

The interesting part of that layout is the gating. `quality` and `e2e` ran
independently. **`docker` was gated on `quality` only** (fast lint/type/unit) so
the ~2–3 min image build **overlapped** the ~2 min `e2e` instead of queuing
behind it. But **`docker-merge` — the job that assigns the human-readable tags —
needed both `docker` and `e2e`**, so nothing got a usable tag until the full
suite was green. Fast where it is safe to be fast, strict where it matters.

### Shared setup

All jobs ran on `ubuntu-latest` with **Node 22** (no version matrix) and pnpm
via `pnpm/action-setup`, taking the version from `package.json`'s
`packageManager` field rather than pinning it in the workflow. Next.js telemetry
was disabled with `NEXT_TELEMETRY_DISABLED` for reproducible builds and no
telemetry calls from CI.

`ci.yml` set `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress:
true }`. Pushing again to the same branch or PR therefore cancelled whatever run
was already in flight — if a run vanished from the Actions tab after a follow-up
push, that was this setting, not a failure.

### `quality` job

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm audit --audit-level=high   # continue-on-error: advisory, non-blocking
```

### `e2e` job

Postgres ran as a GitHub Actions `services:` container using
**`pgvector/pgvector:pg17`** — the RAG migration needs the `vector` extension,
so a stock `postgres` image would not do — health-checked.

MinIO and Mailpit **could not** be `services:` containers. That block supports
only `image`/`env`/`ports`, and the `minio/minio` image needs a `server /data`
command to start at all. The workflow started both explicitly with `docker run`
and polled their health endpoints, mirroring `docker-compose.yml`. The bucket
was `app-files`, created with the `minio/mc` client.

The job then ran `pnpm db:migrate` → `pnpm db:seed` → `pnpm build` →
`pnpm exec playwright install --with-deps chromium` → `pnpm test:e2e`, and
uploaded `playwright-report/` as an artifact (`if: ${{ !cancelled() }}`, 7-day
retention). Email was enabled against Mailpit (`EMAIL_ENABLED=true`,
`SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`) so the reset and verification
round-trips in `email-flow.spec.ts` actually ran. `AUTH_SECRET` was a throwaway
CI value.

**Test isolation.** Each E2E test uses a unique client IP (via
`CF-Connecting-IP`) so rate-limit buckets do not leak between tests — that is
what makes a parallel suite reproducible, and it also means the rate-limit tests
assert something real. Implementation: `tests/e2e/fixtures.ts`. This is still
true locally; it was not a CI-only trick.

### `docker` job (+ `docker-merge`, `release`)

`docker` was gated `needs: [quality]` and ran in **parallel** with `e2e`;
`docker-merge` was gated `needs: [docker, e2e]`, so only tested images were
published. Images were **multi-arch** (`linux/amd64` + `linux/arm64`) so they
run on Apple Silicon Mac minis as well as amd64 servers. To avoid slow QEMU
emulation, `docker` was a matrix that built each architecture on its **own
native runner** (`ubuntu-latest` + `ubuntu-24.04-arm`) and pushed by digest;
`docker-merge` then assembled the per-arch digests into one manifest per image
via `docker/metadata-action`.

Two images, because one cannot do both jobs:

- `ghcr.io/<owner>/<repo>` — the production `runner` target (the app).
- `ghcr.io/<owner>/<repo>/migrate` — the `builder` target, the only one that can
  run `pnpm db:migrate` (the runner standalone image has no tsx and no source).

Tags: the commit `sha`, the branch, semver on `v*` tags, and `latest` on the
default branch. **Pull requests built both arches cache-only and never pushed**
(login was skipped, and `docker-merge` was gated to non-PR runs) so forks stayed
safe. It used the workflow `GITHUB_TOKEN` with `packages: write`.

**Build identity.** The `main`/PR app build baked in
`APP_VERSION=${{ github.ref_name }}` (so `main` on a branch build) and
`APP_GIT_SHA=${{ github.sha }}` as build-args. The Dockerfile persists them as
`ENV` and `src/lib/env.ts` reads them. Because a release tag **re-tagged this
image rather than rebuilding it** (below), the baked `APP_VERSION` stayed
`main`; the deployed version is instead applied at **runtime** from the pinned
`APP_TAG` (`docker-compose.deploy.yml`), while `APP_GIT_SHA` stays baked and
correct. Either way the app surfaces the pair in **Settings → Build**, so an
operator can confirm which version a self-hosted box is running.

On a tag ref, `docker` and `docker-merge` were skipped and the `release` job
re-tagged instead.

### CodeQL

`codeql.yml` ran GitHub's CodeQL `security-and-quality` query suite over the
`javascript-typescript` sources on every push and PR, plus weekly on Monday
06:00 UTC, publishing results to the repository's Security tab.

## Deep dive: the release fast-path

This is the most repo-specific idea in the old pipeline, and the one worth
keeping if you restore it.

A release is a `v*` tag placed on a `main` commit that CI **already built,
tested, and published** (as `sha-<short>` + `latest`) minutes earlier.
Rebuilding on the tag would recompile a bit-identical image just to add the
semver tag — the slowest thing on the whole tag→live path. So on a tag ref the
workflow ran a single `release` job that **added the semver tag — and moved the
floating `stable` tag — on the existing multi-arch digest** with
`docker buildx imagetools create` (a manifest operation, ~30s). `quality`,
`e2e`, `docker` and `docker-merge` were all skipped.

Skipping the tests on a tag sounds unsafe. It is not, because of a wait. The
`release` job **waited** for `ghcr.io/<owner>/<repo>:sha-<short>` (app +
migrate) to exist before re-tagging, so it **inherited `main`'s full gate** —
that image is only published once `main`'s `quality` + `e2e` + build pass. If it
never appeared, the release failed loudly rather than shipping something
untested.

**`stable` always pointed at the most recently released image.** That is the tag
a Tier B box sets `APP_TAG` to for automatic _release-only_ deploys: `latest`
moves on every `main` merge, a pinned semver never moves, and `stable` moves
exactly when a release is cut. Any `v*` push moved it — including an old tag
re-pushed — so the correct rollback is to pin `APP_TAG` to a semver, not to
re-push an old tag.

The `release` job also **created the GitHub Release entry**, so the Releases
page never drifted from the tags. The notes were that version's `CHANGELOG.md`
section, and the title came from the annotated tag's subject
(`git tag -a vX.Y.Z -m "short title"` → "vX.Y.Z — short title"; a lightweight
tag got the bare version). Re-runs skipped an existing release.

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
> the tag at the same time as the merge was still correct: the `release` job
> just waited for `main`'s build (no duplicate compute), then re-tagged.

## Measured: the time-to-deploy budget

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

## Deep dive: how a merge became a live deploy

The ordered walkthrough, from `git push` to a box running the new code, as it
worked when the pipeline existed.

1. A PR merges to `main`.
2. `ci.yml` runs `quality` and `e2e` in parallel; `docker` starts as soon as
   `quality` is green (it does not wait on `e2e`) and builds both
   architectures.
3. Once **both** `docker` and `e2e` are green, `docker-merge` assembles the
   multi-arch manifests and publishes `ghcr.io/<owner>/<repo>` (app) and
   `ghcr.io/<owner>/<repo>/migrate`, tagged `sha-<short>` and `latest`.
4. When you are ready to cut a release: bump the version, update
   `CHANGELOG.md`, and push a `vX.Y.Z` tag on that same commit (see
   [Contributing](../CONTRIBUTING.md)).
5. The tag triggers `ci.yml`'s `release` job, which **waits** for step 3's
   `sha-<short>` image to exist, then re-tags it with the semver, moves the
   floating `stable` tag (~30s, no rebuild) and creates the GitHub Release.
6. A box tracking `APP_TAG=stable` (the recommended default — see
   [Self-hosting → Tier B](self-hosting.md#tier-b-recommended--pull-with-make-deploy))
   picks up the new digest on its next `make deploy-timer` tick (≤60s) and runs
   `make deploy`: pull → migrate → restart. Nothing is pushed to the box — it is
   outbound-only the whole way.

Today steps 1, 4 and 6 still happen — you merge, you tag, and the box polls —
but steps 2, 3 and 5 do not, so nothing is built or published in between and a
release tag ships nothing. [Feature → Production](workflow.md) shows the same
sequence with a manual build step filling that gap.

## If you restore CI

The workflow files are gone, so restoring means writing them again — but the
shape above is the design worth copying, and these rules still apply.

1. Put a new check in the `quality` job. It is the fast, blocking one, next to
   `format:check` / `lint` / `typecheck` / `test:coverage`.
2. If a check is exploratory or has a high false-positive rate — as
   `pnpm audit` did — mark the step `continue-on-error: true` so it reports
   without blocking merges, rather than leaving it out entirely.
3. Expose it as a `pnpm` script in `package.json` if a contributor should be
   able to run it locally before pushing. **CI should never be the only place a
   check can run** — which is exactly why this fork still works without it.
4. If the check belongs in the standard gate, update the pre-push command
   (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`) here, in
   [Usage & Development](usage.md), in `README.md` and in `CONTRIBUTING.md`.
5. Pin one Node version (22 was the pinned one) rather than a matrix, and bump
   it deliberately when you upgrade.
6. Restore image publishing before you enable `deploy.yml` — see
   [What is still in `.github/workflows/`](#what-is-still-in-githubworkflows).

## Troubleshooting

Deploy-time symptoms — 502 Bad Gateway, a login loop, the wrong client IP, a
stale `.env` — are owned by
[Self-hosting → Troubleshooting](self-hosting.md#troubleshooting).

Two failures that are specific to running the suite:

- **Rate-limit leakage between tests.** Check that each test is getting a unique
  client IP from `tests/e2e/fixtures.ts`; a shared IP makes tests interfere.
- **Compose health checks not ready.** The dependency containers are slower than
  the test runner on a cold start. Give them longer, or read their logs:

```bash
# Container logs, following:
docker compose logs -f

# Apply pending database migrations:
pnpm db:migrate

# MinIO status (uses the minio/mc Docker image, not an npm package):
docker run --rm --network host --entrypoint /bin/sh minio/mc \
  -c "mc alias set local http://localhost:9000 minioadmin minioadmin && mc admin info local"
```

Routine maintenance chores that used to be listed here live with their owners:
the migration workflow (edit `src/db/schema.ts` → `pnpm db:generate` → review →
commit → `pnpm db:migrate`) in [Database](database.md), the generated assets
(`pnpm gen:icons`, `pnpm gen:og`) in
[Usage & Development → Scripts](usage.md#scripts), and the rule that every new
environment variable goes into both `src/lib/env.ts` and `.env.example` in
[Usage & Development → Environment variables](usage.md#environment-variables).

---

**Next:** [specs/README.md](../specs/README.md) — the numbered design specs
behind everything in these docs, including
[spec 0024](../specs/0024-faster-time-to-deploy.md), which is where the release
fast-path above was designed.
