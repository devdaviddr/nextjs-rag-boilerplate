---
id: 0022
title: Always-on hardening for self-hosted Mac minis
status: Shipped
release: 'v0.15.0'
created: 2026-07-16
updated: 2026-07-16
---

# 0022 — Always-on hardening for self-hosted Mac minis

## Summary

Turn "it runs on a Mac mini" into "it survives a power cut, runs natively on
Apple Silicon, and shrugs off credential stuffing." Three changes shipped
together in v0.15.0, all serving the same goal — a self-hosted box that stays
up **unattended** and **safe**: boot persistence via a login LaunchAgent
(`make autostart`), native multi-arch container images (amd64 + arm64), and a
global per-IP login rate limit. This is the operational hardening layer on top
of [0020](0020-one-click-self-hosting-setup.md) (provisioning) and
[0021](0021-continuous-deployment-self-hosted.md) (updates).

## Problem / motivation

After 0020/0021 a box can be provisioned and updated, but three gaps remain
between "deployed" and "production always-on":

1. **Reboots kill it.** Containers use `restart: unless-stopped`, so they
   self-heal _while the engine runs_ — but after a power cut nothing starts the
   Docker engine or brings the tunnel stack up. A residential Mac mini that
   loses power comes back dark.
2. **QEMU builds are slow and fragile.** Publishing arm64 images (the whole
   point of a Mac-mini target) via QEMU emulation on an amd64 runner is slow and
   occasionally miscompiles native deps (`@node-rs/argon2`, `sharp`).
3. **Per-account limits don't stop spray attacks.** The existing rate limit is
   keyed on IP+email, so credential stuffing across _many_ accounts from one
   source (one attempt each) never trips a per-account counter.

## Goals

- A rebooted Mac mini brings the full stack back up with **no human present**.
- CI publishes **native** amd64 and arm64 images, fast, with no emulation.
- A single source hammering many accounts is throttled, without weakening the
  existing per-account protection.
- All three are opt-in / zero-impact on the default dev stack and on forks.

## Non-goals

- Watchdog/health-restart beyond what `restart: unless-stopped` + the boot agent
  provide (no external process supervisor).
- Cross-distro/Windows boot persistence — this is a macOS LaunchAgent; Linux
  boxes use systemd (documented, not scripted here).
- Adaptive/behavioural rate limiting or a CAPTCHA — fixed-window counters only
  (a shared-store upgrade is [0017](0017-shared-store-rate-limiting.md)).

## Requirements

### Functional

- **FR1** — **Boot persistence.** `make autostart` installs a login LaunchAgent
  ([`scripts/macos-autostart.sh`](../scripts/macos-autostart.sh)) that, at login,
  waits for the Docker engine and then runs a make target (default `tunnel-up`,
  or `deploy` for pull-based updates). `install [target]` / `uninstall` /
  `status` subcommands.
- **FR2** — **Native multi-arch images.** CI builds amd64 and arm64 on **native
  runners** (`ubuntu-latest` + `ubuntu-24.04-arm`), pushes each by digest, and a
  `docker-merge` job assembles a multi-arch manifest — no QEMU.
- **FR3** — **Global per-IP login cap.** `AUTH_LIMITS.loginPerIp` (50 attempts /
  10 min) enforced in **both** the login server action and the non-bypassable
  credentials `authorize` callback, keyed independently from the per-account
  (IP+email) limit so the two entry points don't double-count.

### Non-functional

- **NFR1** — **Unattended reboot** requires only documented OS settings
  (auto-login, `pmset` no-sleep, runtime-start-at-login) — no bespoke daemon.
- **NFR2** — **Native build correctness.** arm64 images run real arm64 binaries
  (no emulated `@node-rs/argon2`/`sharp`).
- **NFR3** — **No regression** to the per-account limit; the per-IP cap is
  additive and non-bypassable (enforced below the server-action layer).

## Design / approach

**Boot persistence (FR1).** A LaunchAgent is the right primitive on macOS:
LaunchDaemons run too early (before the GUI session Docker Desktop needs), so a
login agent + auto-login is the pragmatic combination. The agent polls for the
Docker engine, then invokes the chosen make target. `restart: unless-stopped`
handles steady-state crashes; this agent only covers the cold-boot gap. Full
unattendedness also needs three OS settings the script documents but can't set
safely for the operator: auto-login, `pmset -a sleep 0 disablesleep 1`, and
runtime-start-at-login (OrbStack/Colima are friendlier than Docker Desktop for
headless boxes).

**Native multi-arch (FR2).** Replace the single QEMU build with a per-arch
matrix on native runners, push-by-digest, then `docker buildx imagetools
create` to stitch the manifest (the `docker-merge` job). Faster and it removes
the emulation-miscompile risk for native modules — see
[`docs/ci-cd.md`](../docs/ci-cd.md).

**Per-IP login cap (FR3).** Add `loginPerIp` to `AUTH_LIMITS`
([`src/lib/rate-limit.ts`](../src/lib/rate-limit.ts)) and check it in the login
action and in the `authorize` callback ([`src/lib/auth/index.ts`](../src/lib/auth/index.ts)).
Enforcing it in `authorize` (not just the action) makes it non-bypassable — any
credential-auth path hits it. Distinct key namespace so a burst of failures
across many accounts trips the per-IP counter without inflating any per-account
one.

**Files:**

- `scripts/macos-autostart.sh` (new), `Makefile` (`autostart` target).
- `.github/workflows/ci.yml` — per-arch matrix + `docker-merge`.
- `src/lib/rate-limit.ts` (`AUTH_LIMITS.loginPerIp`), `src/lib/auth/index.ts`
  (`authorize` enforcement), login server action.
- `docs/self-hosting.md` ("Running on a Mac mini"), `docs/ci-cd.md`,
  `docs/backups.md` (Time Machine caveat), `SECURITY.md`, `README`, `CHANGELOG`.

## Acceptance criteria

- [x] `make autostart` installs a LaunchAgent; after a reboot (with auto-login)
      the stack comes up unattended. Verified live on the **frank** server
      (`frank-boilerplate` tunnel → https://boilerplate.danielruffolo.net).
- [x] CI publishes a multi-arch manifest (amd64 + arm64) built on native
      runners; no QEMU step remains.
- [x] 51 login attempts from one IP inside 10 min are throttled regardless of
      the account targeted; the per-account limit is unchanged. Covered by unit
      tests for the per-IP cap.
- [x] The per-IP check fires in the `authorize` callback, not only the server
      action (non-bypassable).

## Security & privacy

- **Credential-stuffing.** The per-IP cap blunts low-and-slow spray attacks that
  evade per-account limits; enforced non-bypassably in `authorize`.
- **In-memory limiter** is single-instance (per CLAUDE.md) — horizontal scaling
  needs the shared store in [0017](0017-shared-store-rate-limiting.md).
- **Boot persistence** adds no network surface (outbound-only tunnel preserved,
  per [0005](0005-cloudflare-tunnel-deployment.md)); auto-login is a local
  physical-access trade-off the operator opts into.
- **Backups caveat** documented: Docker volumes live in the VM and are **not**
  covered by Time Machine — offsite backups (0009) are the real safety net.

## Alternatives considered

- **LaunchDaemon instead of LaunchAgent** — runs before the GUI session Docker
  Desktop requires; rejected for the Docker-Desktop path.
- **QEMU multi-arch (status quo)** — slower and miscompiles native deps; the
  native-runner matrix is strictly better now arm64 runners exist.
- **Fail2ban-style OS firewall ban** — off-box, opaque to the app, and the
  tunnel hides the real IP unless `CF-Connecting-IP` is threaded through; the
  in-app per-IP counter already sees the right IP.

## Out of scope / future

- Linux/systemd boot unit, and a headless-runtime (Colima) autostart recipe.
- Shared-store rate limiting for multi-instance deploys ([0017](0017-shared-store-rate-limiting.md)).
- SBOM/signing for the published multi-arch images (noted in [0021](0021-continuous-deployment-self-hosted.md)).

## References

- Release **v0.15.0**; builds on [0020](0020-one-click-self-hosting-setup.md)
  and [0021](0021-continuous-deployment-self-hosted.md); inherits
  [0005](0005-cloudflare-tunnel-deployment.md)'s outbound-only posture.
- [`docs/self-hosting.md`](../docs/self-hosting.md) → "Running on a Mac mini",
  [`docs/ci-cd.md`](../docs/ci-cd.md), [`SECURITY.md`](../SECURITY.md).
- Key files: `scripts/macos-autostart.sh`, `src/lib/rate-limit.ts`,
  `src/lib/auth/index.ts`, `.github/workflows/ci.yml`.
