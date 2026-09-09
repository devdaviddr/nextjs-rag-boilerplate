---
id: 0021
title: Continuous deployment for self-hosted instances
status: Shipped
release: 'v0.14.0'
created: 2026-07-16
updated: 2026-07-16
---

# 0021 — Continuous deployment for self-hosted instances

## Summary

Close the loop between CI and a running self-hosted instance: publish the built
image(s) to the GitHub Container Registry (GHCR) on every merge/tag, and give the
box a one-command **pull-based** update path (`make deploy`) plus an **opt-in
self-hosted-runner** workflow for true "merge → live". This extends
[0020](0020-one-click-self-hosting-setup.md) (initial provisioning) with the
_ongoing update_ story, and respects the [0005](0005-cloudflare-tunnel-deployment.md)
tunnel's defining constraint: the box is **outbound-only**.

## Problem / motivation

Today CI (`ci.yml` — since deleted, see [docs/ci-cd.md](../docs/ci-cd.md))
builds a production image and
then **throws it away** (`push: false`), and `docker-compose.prod.yml` builds the
app **on the box** (`build:`, not `image:`). So "deploy a new version" means
SSHing in and rebuilding by hand — and CI verifies an artifact nobody ships.

The wrinkle that shapes the whole design: the box sits behind a Cloudflare Tunnel
with **no inbound ports** (often a dynamic/CGNAT residential IP). The textbook
"cloud runner SSHes into the server" push model can't reach it without punching
an authenticated hole back in. The natural fit is **pull** (the box reaches out)
or an **agent on the box** (a self-hosted runner that dials out to GitHub).

## Goals

- CI publishes a reproducible, CI-gated image artifact to GHCR on merge to `main`
  and on release tags.
- A self-hosted box updates to a published version with **one command**, without
  building locally, and with **migrations applied before the new app starts**.
- A true push-button "merge/tag → live" path for those who want it, honouring the
  outbound-only constraint.
- Opt-in and layered — **zero impact** on the default stack or on forks that don't
  enable it.

## Non-goals

- Multi-node / rolling / blue-green orchestration — single-box `compose up -d`
  (brief recreate gap; the tunnel retries across it).
- Managed-cloud CD targets (Fly, Render, K8s) — off-thesis for self-hosting.
- Secrets/config delivery beyond the image — `.env` stays operator-owned on the box.
- Auto-rollback — documented manual rollback (re-pin the previous tag) only.

## Requirements

### Functional

- **FR1** — **Publish to GHCR.** `ci.yml` builds and pushes to
  `ghcr.io/<owner>/<repo>` on `push` to `main` and on `v*` tags; pull requests
  still **build only** (no push, so forks stay safe). Tags via
  `docker/metadata-action` (commit `sha`, branch, semver on tags, `latest` on the
  default branch).
- **FR2** — **Two images (app + migrate).** Publish the `runner` target as
  `…/<repo>` and the `builder` target as `…/<repo>/migrate`. The migrate image is
  what runs `pnpm db:migrate` (the runner standalone image can't — no tsx/source),
  mirroring the local `migrate` service exactly.
- **FR3** — **Deploy overlay.** `docker-compose.deploy.yml` overrides `app` and
  `migrate` to run the **pre-built** GHCR images (`image:` + `!reset` the `build:`
  key + `pull_policy: always`), parameterised by `APP_IMAGE` / `APP_TAG`.
- **FR4** — **`make deploy`.** One target that `pull`s the pinned images and
  `up -d`s the full production runtime (prod + deploy + tunnel overlays), so the
  one-shot `migrate` runs before `app` starts (existing `depends_on`).
- **FR5** — **Opt-in self-hosted deploy.** A `deploy.yml` workflow that runs
  `make deploy` on a **self-hosted runner on the box**, triggered on release tags,
  gated behind a repo variable (`vars.SELF_HOSTED_DEPLOY == 'true'`) so it never
  runs — or queues — unless the operator opts in.

### Non-functional

- **NFR1** — **No build on the box** in the pull path (the Mac mini pulls, doesn't
  compile).
- **NFR2** — **Migrations before app** on every deploy (the `migrate` one-shot
  gates `app` via `service_completed_successfully`, unchanged from 0005/0009).
- **NFR3** — **Outbound-only preserved.** Neither tier requires an inbound port:
  pull is outbound; the self-hosted runner dials out to GitHub.
- **NFR4** — **Least privilege.** Publishing uses the workflow's `GITHUB_TOKEN`
  with `packages: write`; the box pulls with a read-only PAT (or nothing, if the
  package is public). No long-lived push creds on the box.
- **NFR5** — **Opt-in / no default impact.** Forks and the default stack are
  unaffected until `APP_IMAGE` is set / the repo variable is flipped.

## Design / approach

Two documented tiers, both pull-based, sharing the same GHCR artifacts:

**Tier B (default) — GHCR + `make deploy`.**
`ci.yml` gains publishing (FR1/FR2). On the box the operator sets `APP_IMAGE`
(+ optional `APP_TAG`) in `.env` and runs `make deploy`, which
`pull`s and `up -d`s `prod + deploy + tunnel`. Runs by hand, from `cron`/`launchd`,
or from Tier C. Because the one-shot `migrate` image is published and wired into
`depends_on`, **schema changes deploy safely**.

**Tier C (power) — self-hosted runner.**
Register the box as a GitHub self-hosted runner; `deploy.yml` runs `make deploy`
there on tag push. The runner dials out (tunnel-friendly). Gated by
`vars.SELF_HOSTED_DEPLOY` and restricted to tags/`main` so fork PRs can never
execute on the box.

**Key decision — migrations from a registry image.** The runner standalone image
can't run `tsx src/db/migrate.ts`. Rather than re-architect the image, publish the
existing **builder** target as a second `…/migrate` image and keep the compose
`migrate` service pointed at it. Cost: a larger second image in GHCR. Benefit:
provably identical to today's local `migrate` service; no Dockerfile risk. A
_self-migrating single image_ (bake a compiled migrator into `runner`) is a clean
future optimization (see Out of scope).

**Files:**

- `.github/workflows/ci.yml` — GHCR login (non-PR), `docker/metadata-action`,
  push both targets; `permissions: packages: write`.
- `docker-compose.deploy.yml` (new) — `image:` overlay for `app` + `migrate`.
- `.github/workflows/deploy.yml` (new) — opt-in self-hosted `make deploy` on tag.
- `Makefile` — `deploy` target.
- `.env.example` — `APP_IMAGE` / `APP_TAG`.
- `docs/self-hosting.md` / `docs/ci-cd.md` — the two tiers, the **migration** and
  **Watchtower** caveats; `README` + `CHANGELOG`.

**Watchtower caveat (documented, not shipped).** Watchtower auto-pulls the `app`
container but **won't run the one-shot `migrate`**, so it silently skips schema
changes — only safe for migration-free releases. `make deploy` is the correct
primitive; Watchtower is mentioned as an optional convenience with this caveat.

## Acceptance criteria

- [ ] A push to `main` publishes `ghcr.io/<owner>/<repo>` (app) and
      `…/<repo>/migrate` (builder), tagged by sha + `latest`; a `v*` tag adds the
      semver tag. PRs build but do not push.
- [x] On a box with `APP_IMAGE` set, `make deploy` pulls both images, runs
      migrations, then starts the app behind the tunnel — **no local build**.
      _(verified via a local registry: migrate/builder image ran migrations →
      app/runner image pulled + healthy)._
- [x] `docker compose … -f docker-compose.deploy.yml config` resolves to `image:`
      (no `build:`) for `app` and `migrate`.
- [x] `deploy.yml` does nothing unless `vars.SELF_HOSTED_DEPLOY == 'true'`, and
      then deploys on a release tag from a self-hosted runner. _(Verified live
      on the **frank** server, 2026-07-16: `frank` launchd runner + tunnel
      `frank-boilerplate` → https://boilerplate.danielruffolo.net; skip-when-unset
      confirmed before enabling, then every `v*` tag auto-deploys there.)_
- [x] Nothing changes for a fork that sets neither `APP_IMAGE` nor the repo
      variable. _(PR #9's `docker` job built both images without pushing.)_

> **No longer verifiable (2026-09-09).** The open box describes `ci.yml`
> publishing images to GHCR on a push to `main`. That workflow was deleted from
> this fork ([docs/ci-cd.md](../docs/ci-cd.md)); nothing publishes an image now,
> so the criterion cannot be exercised. The PR half of it — build without
> pushing — is evidenced by the last box.

## Security & privacy

- **Fork safety.** Publishing and self-hosted deploy are disabled for PRs / when
  the repo variable is unset — untrusted PR code can never push an image or run on
  the box.
- **Least-privilege registry.** Push via `GITHUB_TOKEN` (`packages: write`) in the
  trusted workflow; the box pulls read-only (public package, or a read `PAT`).
- **Self-hosted runner risk (Tier C).** A runner executes workflow code on the
  operator's network — documented as private-repo / trusted-tag / ideally
  **ephemeral** only. Tier B (pull) avoids this entirely and is the default.
- Inherits 0005's posture: no inbound ports, TLS at Cloudflare, `CF-Connecting-IP`.

## Alternatives considered

- **Box pulls git + rebuilds (GitOps-lite)** — simplest, but builds on the Mac
  mini and couples weakly to CI. Kept as a documented "no-registry" fallback.
- **Push via Cloudflare Access + `cloudflared` SSH** — true push reusing
  Cloudflare, but exposes (gated) SSH and needs a service token in CI.
- **Overlay network (Tailscale/WireGuard)** — secure push, but a new dependency +
  ephemeral keys in CI.
- **Webhook receiver on the box** — push-trigger/pull-execute, but a new
  authenticated endpoint = new surface.
- **Watchtower as the deploy mechanism** — unsafe for migrations (see caveat).

## Out of scope / future

- Self-migrating single image (compiled migrator baked into `runner`) to drop the
  second GHCR image.
- Auto-rollback, remote Terraform state, staging environment, CD to managed clouds.
- SBOM/image signing (cosign) and provenance attestation.

## References

- Builds on [0005 — Cloudflare Tunnel deployment](0005-cloudflare-tunnel-deployment.md)
  and [0020 — One-click self-hosting setup](0020-one-click-self-hosting-setup.md).
- Related: [0009 — Automated backups](0009-automated-backups.md); the CI pipeline
  in [`docs/ci-cd.md`](../docs/ci-cd.md) and `Dockerfile` (builder/runner targets).
- Will add on implementation: `docker-compose.deploy.yml`,
  `.github/workflows/deploy.yml`, `ci.yml` publish steps, `make deploy`.
