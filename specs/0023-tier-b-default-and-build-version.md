---
id: 0023
title: Pull-based deploy as the default + deployed build version in Settings
status: Shipped
release: 'v0.16.0'
created: 2026-07-16
updated: 2026-07-16
---

# 0023 — Pull-based deploy as the default + deployed build version in Settings

## Summary

Two related changes that make self-hosted deployment **safer to run against a public repo** and
**observable**: (1) make the **pull-based** deploy (Tier B) the recommended default — a scheduled
`make deploy` timer on the box — and step **away from the self-hosted GitHub Actions runner**
(Tier C) for public repositories; and (2) **bake the build version + commit SHA into the image**
at CI time and surface it in the app's **Settings** page, so an operator can see exactly which
version a box is running after an unattended pull.

## Problem / motivation

**Security.** [0021](0021-continuous-deployment-self-hosted.md) shipped Tier C — a self-hosted
runner on the box that deploys on `v*` tags. On a **public** repo this is the exact configuration
GitHub warns against: a fork pull request can add a workflow targeting `runs-on: [self-hosted]` and,
once approved to run, executes arbitrary code **on the box, on the home LAN**. The `first_time_contributors`
approval policy only gates a contributor's _first_ PR, and the `SELF_HOSTED_DEPLOY` gate doesn't help
(a fork brings its own workflow). Mitigating this (ephemeral + sandboxed + all-contributor approval +
never mis-clicking) is more work and more standing risk than simply **not having a runner**. Tier B
(pull) removes the entire attack surface: GitHub never runs repo code on the box.

**Observability.** After an unattended pull there is **no way, from the app, to tell which version is
live**. The running container knows nothing about its own build — no version, no commit. An operator
verifying a deploy has to shell into the box and inspect image tags.

## Goals

- Make pull-based deploy (Tier B) the **documented default**, with a first-class, reproducible
  **scheduled timer** (not a hand-rolled cron on one box).
- **Deregister the self-hosted runner** on the live instance (frank) and disable the Tier C gate.
- Bake **version + short commit SHA** into the published image at build time.
- Show the deployed version in the app **Settings** page for any signed-in user.
- Keep Tier C available but clearly **opt-in for private/trusted repos only**, with a loud warning.

## Non-goals

- Deleting Tier C entirely — it stays valid for private repos; only its default/recommended status
  and the live frank runner change.
- An update/rollback UI in the app — Settings only _displays_ the version (read-only).
- Build provenance/SBOM/signing (still future, per [0021](0021-continuous-deployment-self-hosted.md)).
- Exposing the version publicly/unauthenticated — it's shown to signed-in users only.

## Requirements

### Functional

- **FR1** — **Build version baked in.** CI passes `APP_VERSION` (the git ref name — semver tag on a
  release, `main` on a branch build) and `APP_GIT_SHA` (`github.sha`) as Docker **build-args**; the
  runner image persists them as `ENV`.
- **FR2** — **Env exposure.** `APP_VERSION` / `APP_GIT_SHA` are optional vars in `src/lib/env.ts`,
  readable in Server Components (no `NEXT_PUBLIC_`; not sent to the client bundle wholesale).
- **FR3** — **Settings display.** A "Build" card on `/settings` shows the version and the short
  (7-char) commit SHA to any signed-in user; degrades gracefully to "development build" /
  "unknown" when the vars are absent (local `next dev`, un-baked image).
- **FR4** — **Tier B timer.** A `scripts/macos-deploy-timer.sh` (`install [interval] | uninstall |
status`) installs a launchd agent that runs `make deploy` on an interval (default 5 min), plus a
  `make deploy-timer` convenience target. Documented as the recommended self-host deploy path.
- **FR5** — **Runner stand-down (frank).** Deregister the `frank` self-hosted runner, set the repo
  variable `SELF_HOSTED_DEPLOY=false`, and install the Tier B timer on the box.

### Non-functional

- **NFR1** — **Cache-friendly.** The version `ARG`/`ENV` sit **late** in the runner stage so a
  per-commit SHA change only busts a tiny final layer, not the whole image.
- **NFR2** — **No new attack surface.** Tier B is outbound-only (the box pulls); no inbound port,
  no code execution from GitHub on the box.
- **NFR3** — **Graceful absence.** Missing build vars never break boot or the Settings page.
- **NFR4** — **Least disclosure.** Only version + short SHA are shown, to authenticated users.

## Design / approach

**Image (FR1/NFR1).** In `Dockerfile`'s `runner` stage, just before `USER`/`CMD`:

```dockerfile
ARG APP_VERSION=unknown
ARG APP_GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION APP_GIT_SHA=$APP_GIT_SHA
```

`ci.yml`'s app `build-push-action` step gains:

```yaml
build-args: |
  APP_VERSION=${{ github.ref_name }}
  APP_GIT_SHA=${{ github.sha }}
```

So `latest` (main build) reads `main` + sha; a pinned `0.16.0` reads `v0.16.0` + sha.

**Env (FR2).** Add `APP_VERSION` / `APP_GIT_SHA` as `optionalStr` in `src/lib/env.ts`. They are
server-only (a Server Component reads `env.APP_VERSION`); no secret, but no reason to inline into
every client bundle either.

**Settings (FR3).** A `BuildInfoCard` server component (matches the `Card`/`CardHeader`/`CardContent`
house style of `current-user-card.tsx`) rendered at the bottom of the settings list. Shows
`APP_VERSION` and `APP_GIT_SHA?.slice(0, 7)`, with a fallback line when unset.

**Tier B timer (FR4).** `scripts/macos-deploy-timer.sh` mirrors `scripts/macos-autostart.sh`: writes
a `LaunchAgent` plist with `StartInterval` that runs a wrapper doing `git pull` + copy operator
`.env` + `make deploy`. `install`/`uninstall`/`status` subcommands; `make deploy-timer` wraps
`install`.

**Runner stand-down (FR5).** On frank: `./config.sh remove` (or `svc.sh uninstall` + remove) for the
runner, `gh variable set SELF_HOSTED_DEPLOY -b false`, install the Tier B timer, verify a pull cycle.
`deploy.yml` stays in the repo but gets a strengthened header warning and is documented as
private-repo-only.

**Files:**

- `Dockerfile` — version `ARG`/`ENV` in `runner`.
- `.github/workflows/ci.yml` — `build-args` on the app build step.
- `src/lib/env.ts` — two optional vars.
- `src/components/settings/build-info-card.tsx` (new) + wired into the settings page/client.
- `scripts/macos-deploy-timer.sh` (new), `Makefile` (`deploy-timer` target).
- `.github/workflows/deploy.yml` — louder public-repo warning.
- `docs/self-hosting.md`, `docs/ci-cd.md`, `SECURITY.md`, `.env.example`, `README`, `CHANGELOG`.

## Acceptance criteria

- [x] A tag build bakes `APP_VERSION`/`APP_GIT_SHA` into the image; `docker inspect` shows the ENV. —
      `Dockerfile` declares `ARG`/`ENV` for both and the release job passed them;
      re-tagging (0024) later moved `APP_VERSION` to runtime via `APP_TAG`.
- [x] `/settings` shows "Build vX.Y.Z · <sha7>" for a baked image, and a graceful fallback under
      `next dev`. —
      `src/app/(dashboard)/settings/page.tsx` passes `env.APP_VERSION` into
      `BuildInfoCard`, which falls back gracefully when unset.
- [x] `make deploy-timer` installs a launchd agent that pulls + deploys on the interval;
      `... status` reports it; `... uninstall` removes it. —
      `Makefile` target → `scripts/macos-deploy-timer.sh`, which implements
      `install`, `uninstall` and `status`.
- [ ] On frank: the `frank` runner is deregistered (gone from repo → Settings → Actions → Runners),
      `SELF_HOSTED_DEPLOY=false`, and the Tier B timer keeps the box current within one interval.
- [x] `docs/self-hosting.md` presents Tier B as the default and Tier C as private-repo-only with the
      fork-PR warning. —
      "Tier B (recommended)" and "Tier C (private repos only)" with the
      fork-PR warning are both present in `docs/self-hosting.md`.

> **Not verified (2026-09-09).** The remaining box is live infrastructure
> state on the operator's box, not something the repository can attest to.

## Security & privacy

- **Removes the self-hosted-runner RCE surface** on the public repo (the motivating threat) by not
  running a runner on frank; Tier B is outbound-only.
- **Version disclosure** is limited to version + short SHA, authenticated users only — enough for an
  operator to confirm a deploy without publishing precise build coordinates to the anonymous
  internet.
- Tier C retained for **private** repos with the documented ephemeral-runner guidance from
  [0021](0021-continuous-deployment-self-hosted.md).

## Alternatives considered

- **Harden the runner instead (ephemeral + sandbox + all-contributor approval).** More moving parts
  and a standing capability whose safety depends on perfect config + never mis-approving; strictly
  weaker than removing it. Rejected as the default for public repos.
- **Make the repo private.** Solves the runner risk but defeats the boilerplate's showcase purpose.
- **Show version via a public `/api/version` or footer.** Broader disclosure with no operator
  benefit over an authenticated Settings card.
- **Read version from `package.json` at runtime.** The standalone image doesn't ship `package.json`
  reliably, and it wouldn't capture the commit SHA; build-args are the honest source.

## Out of scope / future

- In-app "update available / deploy now / rollback" controls.
- Image signing/SBOM/provenance attestation.
- A Linux/systemd equivalent of the deploy timer (macOS launchd only here).

## References

- Supersedes the **default** deploy posture of [0021](0021-continuous-deployment-self-hosted.md)
  (Tier C → Tier B) and builds on [0022](0022-always-on-hardening-mac-mini.md) (autostart timer
  pattern) and [0020](0020-one-click-self-hosting-setup.md).
- Key files: `Dockerfile`, `.github/workflows/ci.yml`, `src/lib/env.ts`,
  `src/components/settings/build-info-card.tsx`, `scripts/macos-deploy-timer.sh`, `Makefile`.
- GitHub guidance: self-hosted runners are not recommended on public repositories.
