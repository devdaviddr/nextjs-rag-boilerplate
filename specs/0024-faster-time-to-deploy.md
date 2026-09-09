---
id: 0024
title: Faster time-to-deploy — re-tag on release, overlap build with e2e, tighter pull loop
status: Shipped
release: 'v0.17.0'
created: 2026-07-16
updated: 2026-07-16
---

# 0024 — Faster time-to-deploy

## Summary

Cut the wall-clock from **`git push` of a `v*` tag → live on the box** without weakening any
quality gate. Three independent changes: (1) a **release tag no longer rebuilds** — it re-tags the
multi-arch image the `main` push already built and tested for that exact commit; (2) on `main`, the
**image build overlaps `e2e`** instead of queuing behind it; and (3) the **Tier B pull timer** polls
on a short interval (default 60s) and **skips the deploy when the published image is unchanged**, so
frequent polling is nearly free.

## Problem / motivation

A release currently flows `tag → ci.yml → GHCR → frank's Tier B pull timer → live`. Measured on the
`v0.16.x` releases, the budget was:

| Phase                            | Time                      | Note                                      |
| -------------------------------- | ------------------------- | ----------------------------------------- |
| CI pipeline (tag)                | **~5m27s**                | measured on `v0.16.3`                     |
| ├ `quality`                      | 55s                       | parallel                                  |
| ├ `e2e`                          | 1m45s                     | parallel — **the gate long-pole**         |
| ├ `docker` build (gated on both) | amd64 2m06s / arm64 2m27s | starts only after `e2e`                   |
| └ `docker-merge`                 | 28s                       | manifest assembly                         |
| Poll wait (Tier B timer)         | **0–300s** (avg 150s)     | `StartInterval=300`                       |
| Deploy on box                    | ~1–2 min                  | pull app + heavy migrate image + recreate |
| **Total (tag → live)**           | **~9–13 min**             |                                           |

Three structural inefficiencies drive this:

- **Every release builds the identical commit twice.** A `v*` tag sits on a `main` commit that
  already ran the full pipeline and published a multi-arch image (`sha-<short>` + `latest`) minutes
  earlier. The tag then re-runs **the entire pipeline** to produce a bit-identical image whose only
  difference is the semver tag — the slowest thing on the critical path is redundant.
- **The build queues behind `e2e`.** `docker` was gated `needs: [quality, e2e]`, so the ~2–3 min
  build didn't start until the ~2 min `e2e` finished — two slow phases in series.
- **The pull timer runs blind.** It fired every 300s and always ran the full `make deploy` (pull
  app, pull the large `builder`-target migrate image, `up -d`) even when nothing had changed, so a
  new release waited up to a full 5-minute interval and idle ticks did real work.

The box ([frank](../CLAUDE.md)) pins a **semver `APP_TAG`** (not `latest`), so the **release-tag
pipeline is squarely on its critical path** — optimizing it is what moves time-to-deploy.

## Goals

- A `v*` tag publishes the release image in **~30s** (a manifest re-tag), not a ~5-minute rebuild.
- **No weaker gate:** the re-tag can only succeed if `main`'s `quality` + `e2e` + build for the same
  commit went green (it waits for that image to exist).
- On `main`, the image build **overlaps `e2e`**; a human tag is still only assigned once the full
  suite passes.
- The box lands a new release within **~1 interval (default 60s)**, and idle polling is a fast no-op.
- Keep the observability from [0023](0023-tier-b-default-and-build-version.md): Settings → Build
  still shows the deployed version + commit.

## Non-goals

- Changing the two-image (app + migrate) model or the Cloudflare Tunnel / outbound-only posture.
- A self-migrating single image (still the future optimization from
  [0021](0021-continuous-deployment-self-hosted.md)).
- Auto-rollback, blue-green, or a Linux/systemd port of the timer.
- Speeding up the one unavoidable `main` build itself (a genuine `next build` on new source; its
  cost is real compute, not overhead).

## Requirements

### Functional

- **FR1 — Re-tag, don't rebuild.** On `github.ref_type == 'tag'`, `ci.yml` runs a single `release`
  job that adds the semver tag (`v0.16.3` → `0.16.3`) to the **existing** `sha-<short>` digest of
  both the app and migrate images via `docker buildx imagetools create`. `quality`, `e2e`, `docker`,
  and `docker-merge` are all skipped for tag refs.
- **FR2 — Inherit main's gate.** The `release` job **waits** (poll `imagetools inspect`, ~13 min cap)
  for the `sha-<short>` app+migrate images to be published, then re-tags. Because that image is only
  published after `main`'s `quality` + `e2e` + build succeed, the tag inherits the full gate with no
  re-run. If the source image never appears, the release **fails loudly**.
- **FR3 — Runtime version identity.** The re-tagged image carries `main`'s baked `APP_VERSION=main`,
  so the deployed version is set at **runtime** from the tag the box pulled:
  `APP_VERSION: ${APP_TAG}` on the `app` service in `docker-compose.deploy.yml`. `APP_GIT_SHA` stays
  baked (it's the correct commit either way). Settings → Build shows `APP_TAG · <sha7>`.
- **FR4 — Build overlaps e2e.** `docker` is gated `needs: [quality]` (fast lint/type/unit) and runs
  in parallel with `e2e`; `docker-merge` (which assigns the human tags) is gated `needs: [docker,
e2e]`, so no tagged image exists unless the full suite passed. Build-by-digest blobs from a failed
  `e2e` are harmless untagged manifests.
- **FR5 — Short, digest-skipped pull loop.** The Tier B timer defaults to a **60s** interval. Each
  tick refreshes only the app image manifest, compares its ID to the last-deployed ID
  (`~/.config/<repo>/.last-deployed-image`), and **exits immediately if unchanged**; it runs the full
  `make deploy` only on a change, then records the new ID.

### Non-functional

- **NFR1 — No new attack surface.** Re-tagging uses the workflow `GITHUB_TOKEN` (`packages: write`)
  in the trusted, tag-triggered job; the box stays outbound-only (0021/0023 posture unchanged).
- **NFR2 — Fork/PR-safe.** PRs still build both arches cache-only and never push (`docker` runs,
  `docker-merge`/`release` don't). The `release` job only runs on tag refs.
- **NFR3 — Idempotent, engine-agnostic ticks.** The digest check uses only `docker pull` +
  `docker image inspect` (Podman-safe — no `buildx`/`manifest` on the box); an unchanged tick makes
  no container changes.
- **NFR4 — Graceful.** A missing/private image, an unreadable `.env`, or a not-yet-published source
  image degrade to a logged skip or a loud, actionable failure — never a half-deploy.

## Design / approach

**CI (`ci.yml`).**

- `quality` / `e2e`: `if: github.ref_type != 'tag'`.
- `docker`: `needs: [quality]`, `if: github.ref_type != 'tag'` (build overlaps e2e; tags don't build).
- `docker-merge`: `needs: [docker, e2e]`, `if: … != 'pull_request' && github.ref_type != 'tag'`.
- new `release` job (`if: github.ref_type == 'tag'`): login → resolve `VERSION=${GITHUB_REF_NAME#v}`
  and `SHA_TAG=sha-${GITHUB_SHA:0:7}` → wait for `${IMAGE}:${SHA_TAG}` (app + migrate) → `imagetools
create -t ${IMAGE}:${VERSION} ${IMAGE}:${SHA_TAG}` for both → inspect.

**Runtime version (`docker-compose.deploy.yml`).** Add `environment: { APP_VERSION: ${APP_TAG:-latest} }`
to `app`. Compose env overrides the image's baked `ENV`, so Settings shows the deployed tag.

**Pull timer (`scripts/macos-deploy-timer.sh`).** Default interval `300 → 60`. In `tick()`, after
staging `.env`, read `APP_IMAGE`/`APP_TAG`, `docker pull` the app ref, and compare
`docker image inspect --format '{{.Id}}'` to `$STATE_FILE`; `return 0` on a match, else `make deploy`
and record the new ID. `app` and `migrate` re-tag in lockstep per release, so the app digest is a
sufficient change signal.

**Recommended release flow (to realize the win).** Merge to `main` → let `main` CI go green (it
builds + tests + publishes the `sha-<short>` image) → **then** push the `v*` tag. The `release` job
finds the image immediately and re-tags in ~30s. If the tag is pushed simultaneously with the merge,
the `release` job simply waits for `main`'s build (no duplicate compute), then re-tags.

**Files:**

- `.github/workflows/ci.yml` — `if`/`needs` on quality/e2e/docker/docker-merge; new `release` job.
- `docker-compose.deploy.yml` — runtime `APP_VERSION` on `app`.
- `scripts/macos-deploy-timer.sh` — default 60s + digest-skip; `Makefile` help text.
- `.env.example` — note runtime `APP_VERSION`.
- `docs/ci-cd.md`, `docs/self-hosting.md`, `CHANGELOG.md`.

## Acceptance criteria

- [x] A `v*` tag runs only the `release` job (quality/e2e/docker/docker-merge show "skipped") and
      publishes `…:X.Y.Z` for app + migrate by re-tagging the `sha-<short>` digest — no build step. —
      observed at ship time and recorded in `CHANGELOG.md` v0.17.0: "Tag CI drops
      from ~5m27s to ~30s", which only holds if the build jobs were skipped.
- [ ] `docker buildx imagetools inspect …:X.Y.Z` shows the same digest as `…:sha-<short>` (multi-arch
      preserved), and `/settings` on the box shows `X.Y.Z · <sha7>`.
- [x] On `main`, `docker` starts after `quality` (not `e2e`); `docker-merge` waits for `e2e`; a failed
      `e2e` yields no tagged image. —
      `CHANGELOG.md` v0.17.0 records the shipped wiring: `docker` gated on
      `quality` only, `docker-merge` gated on both, so a failed `e2e` yields no
      tagged image.
- [x] `make deploy-timer` installs a 60s agent; an idle tick logs "up to date … nothing to deploy"
      and changes no containers; a new release deploys within one interval. —
      `scripts/macos-deploy-timer.sh` defaults to 60s and compares the pulled
      digest against `.last-deployed-image` before doing anything;
      `CHANGELOG.md` v0.17.0 records the digest-skip behaviour.
- [ ] PRs still build both arches cache-only and push nothing.

> **No longer verifiable (2026-09-09).** The two open boxes describe
> `ci.yml` behaviour — the multi-arch digest match on a re-tagged image, and
> PRs building cache-only without pushing. That workflow was deleted from this
> fork ([docs/ci-cd.md](../docs/ci-cd.md)), so there is no longer a run that
> could close them. They are left open rather than assumed.

## Security & privacy

- Re-tagging is a trusted, tag-only job using `GITHUB_TOKEN`; no new inbound surface, no code from
  GitHub runs on the box (Tier B unchanged). Version disclosure stays as 0023: version + short SHA to
  authenticated users only.
- The overlap change publishes build-by-digest blobs before `e2e` finishes on `main`; these are
  **untagged** and only become referenced by `docker-merge` after the suite passes. Untrusted PR code
  still never pushes.

## Alternatives considered

- **Skip only the tests on tags but still rebuild.** Simpler and keeps the baked version label, but
  leaves the ~2–3 min rebuild on the critical path (~5.5 → ~3.5 min vs ~30s). Rejected as the primary
  lever; the re-tag subsumes it.
- **Registry/inline build cache instead of GHA cache.** The tag rebuild's slowness was cache-restore
  overhead — but re-tagging removes the tag rebuild entirely, and the remaining `main` build is a
  genuine recompile of changed source that cache can't avoid. Not worth the added moving parts.
- **Event-driven deploy (webhook/repository_dispatch to the box).** Lower latency than polling but
  reintroduces an inbound trigger / new surface — against the outbound-only thesis. A 60s
  digest-skipped poll gets ~the same latency for free.
- **Re-tag from `:latest` instead of `:sha-<short>`.** `latest` can move to a newer `main` commit
  between merge and tag; the per-commit `sha` tag is the immutable, correct source.

## Out of scope / future

- Self-migrating single image (drop the second GHCR image and the heavy migrate pull).
- Only pulling/running `migrate` when its digest changed (minor; the migrator is idempotent and fast).
- A Linux/systemd `deploy-timer` equivalent; auto-rollback; staging environment.

## References

- Builds on [0021 — Continuous deployment](0021-continuous-deployment-self-hosted.md) and
  [0023 — Tier B default + build version](0023-tier-b-default-and-build-version.md); inherits the
  [0005](0005-cloudflare-tunnel-deployment.md) tunnel posture.
- Key files: `.github/workflows/ci.yml`, `docker-compose.deploy.yml`,
  `scripts/macos-deploy-timer.sh`, `docs/ci-cd.md`.
