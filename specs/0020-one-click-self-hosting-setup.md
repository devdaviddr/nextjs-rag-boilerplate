---
id: 0020
title: One-click self-hosting setup
status: Shipped
release: 'v0.14.0'
created: 2026-07-16
updated: 2026-07-16
---

# 0020 — One-click self-hosting setup

## Summary

Add a single, guided entrypoint — `make setup` (wrapping `scripts/setup.sh`) —
that takes a fresh clone all the way to a running instance behind the user's own
Cloudflare-tunnelled domain, and a comprehensive narrative **self-hosting guide**
(`docs/self-hosting.md`) that frames the whole journey. This does **not**
re-implement deployment; it orchestrates the primitives that [0005](0005-cloudflare-tunnel-deployment.md)
already shipped (the `docker-compose.*tunnel.yml` overlays, the `infra/cloudflare/`
Terraform module, the `Makefile` targets, and `scripts/tunnel-verify.sh`) into one
idempotent, re-runnable flow, and seeds + verifies at the end.

## Problem / motivation

The building blocks for self-hosting exist and work (0005), but a newcomer must
today: read `docs/deployment.md`, hand-generate `AUTH_SECRET`, hand-author
`.env`, choose among three on-ramps, copy `terraform.tfvars.example`, fill in
four Cloudflare IDs, run `make tunnel-provision`, remember to set `AUTH_URL`, run
`make tunnel-up`, then separately seed a first user and verify. Each step is
individually documented but the _sequence_ is tribal knowledge, and a mistake in
any one (a missing `AUTH_URL`, an unset S3 var the migrator validates, a wrong
ingress target) fails in a way that's hard to diagnose. "1-click" collapses that
sequence into one reviewed, guided command — the difference between a boilerplate
people _read about_ and one they _run_.

## Goals

- **One command** from clone → app live behind the user's Cloudflare domain over
  HTTPS, with a seeded admin and a green health check.
- **Guided but reviewable** — the wizard explains each step and the exact
  primitive it will run, and never hides an irreversible action.
- **Idempotent & re-runnable** — safe to re-run; never clobbers existing secrets
  without explicit confirmation.
- **All three 0005 on-ramps** reachable from the one entrypoint (quick demo /
  guided dashboard token / automated Terraform), converging on the same runtime.
- **A comprehensive guide** (`docs/self-hosting.md`) that a non-expert can follow
  start to finish, with the wizard as the happy path and manual steps as the
  fallback.

## Non-goals

- Re-implementing tunnel/DNS provisioning — Terraform (`infra/cloudflare/`) stays
  the source of truth for the automated path; the wizard shells out to the
  existing `make tunnel-*` targets.
- Provisioning **managed Postgres/object storage** or any cloud beyond Cloudflare
  Tunnel — the target remains the single-box Docker Compose stack.
- Kubernetes / Swarm / multi-node orchestration, and CD-from-CI (deferred, see
  0005 out-of-scope).
- Cloudflare Access SSO (already an optional documented add-on in 0005).
- A GUI / web installer — this is a terminal wizard (bash), Windows via WSL.

## Requirements

### Functional

- **FR1** — `make setup` runs `scripts/setup.sh`, an interactive wizard that
  drives the full flow: preflight → secrets → mode → provision (mode-dependent)
  → up → seed → verify → summary.
- **FR2** — **Preflight**: verify Docker is running, Docker Compose ≥ v2.24 (the
  overlays use a newer merge feature — see `docs/deployment.md`), and, for the
  automated mode only, that `terraform` is on `PATH`. Fail with an actionable
  message naming the missing tool, not a stack trace.
- **FR3** — **Secrets**: generate a strong `AUTH_SECRET`
  (`openssl rand -base64 33`) and write `.env` from `.env.example` if absent.
  If `.env` already has a non-empty `AUTH_SECRET`, keep it and say so; only
  overwrite on explicit confirmation. Never echo secret values to stdout/logs.
- **FR4** — **Mode selection**: prompt for one of
  (a) **quick** demo (`make tunnel-quick`, ephemeral `*.trycloudflare.com`, no
  account), (b) **guided** named tunnel (prompt for the dashboard-issued
  `CLOUDFLARE_TUNNEL_TOKEN` + hostname, then `make tunnel-up`), (c) **automated**
  named tunnel (collect the four Cloudflare inputs, write
  `infra/cloudflare/terraform.tfvars`, `make tunnel-provision && make tunnel-up`).
- **FR5** — For modes (b)/(c), set `AUTH_URL=https://<hostname>` in `.env`
  automatically (the single most-missed manual step today).
- **FR6** — **Seed**: after the app is healthy, run the demo-admin seed
  (`docker compose … run --rm migrate pnpm db:seed`) unless `--no-seed` is passed;
  print the seeded credentials once.
- **FR7** — **Verify**: run `scripts/tunnel-verify.sh` (quick/named) or the local
  `/api/health` probe (quick demo) and only report success on a green check.
- **FR8** — **Non-interactive mode**: every prompt is satisfiable via a flag or
  env var (e.g. `SETUP_MODE=automated CF_API_TOKEN=… … make setup`) so the flow
  is scriptable and CI-testable; `--help` documents them.
- **FR9** — **Summary**: end by printing the live URL, the admin login, and the
  next-step commands (logs, stop, teardown), plus a one-line teardown pointer
  (`make tunnel-destroy` / `docker compose … down -v`).
- **FR10** — **AI-agent skills**: ship a `self-host` [Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview)
  for both **Claude Code** (`.claude/skills/self-host/SKILL.md`) and **opencode**
  (`.opencode/skills/self-host/SKILL.md`) so a user can tell their agent "self-host
  this" and have it drive `make setup` (pick mode, collect Cloudflare inputs, run,
  verify). The skill is a thin runbook over the wizard — same secret-hygiene rules,
  no bypass of any documented step.

### Non-functional

- **NFR1** — **Idempotent**: re-running `make setup` converges rather than
  duplicating (`.env` keys updated in place, `terraform apply` is already
  idempotent, seed is already idempotent).
- **NFR2** — **Secret hygiene**: `.env` and `terraform.tfvars` are created
  `chmod 600`, are already gitignored, and no secret is printed or committed.
  Reuses 0005's least-privilege split (scoped API token at provision time only;
  runtime holds only the tunnel token).
- **NFR3** — **Portable bash**: POSIX-ish `bash`, macOS + Linux; no hard
  dependency beyond `docker`, `openssl`, and (automated mode) `terraform`.
  `set -euo pipefail`; clear failure at the first broken precondition.
- **NFR4** — **No new runtime deps and zero impact on the default stack** — the
  wizard is pure orchestration over existing files; not running it changes
  nothing.

## Design / approach

**Entry point.** A new `setup:` target in the `Makefile` runs
`scripts/setup.sh`. The script is a thin, well-commented orchestrator — it makes
decisions and collects input, then calls the _existing_ `make tunnel-*` targets
and compose commands. No provisioning logic is duplicated here.

**Flow (state machine):**

```text
preflight ─▶ secrets(.env, AUTH_SECRET) ─▶ mode?
   ├─ quick     ─▶ make tunnel-quick ──────────────▶ (URL from cloudflared logs)
   ├─ guided    ─▶ prompt token+host ─▶ .env ─▶ make tunnel-up
   └─ automated ─▶ prompt CF inputs ─▶ tfvars ─▶ make tunnel-provision ─▶ .env(AUTH_URL) ─▶ make tunnel-up
                                                              │
                                     seed (unless --no-seed) ─┼─▶ verify ─▶ summary(URL, creds, next steps)
```

**Files:**

- `scripts/setup.sh` (new) — the wizard. Functions per step; a `--help` and
  env-var overrides for non-interactive use.
- `Makefile` — add `setup:` (and list it in `help`).
- `docs/self-hosting.md` (new) — the narrative guide: prerequisites, buying/using
  a domain on Cloudflare, `make setup` walkthrough with sample transcript, what
  each mode is for, verifying, day-2 operations (logs, updates, backups →
  [backups.md](../docs/backups.md)), and troubleshooting. `docs/deployment.md`
  stays as the **reference** (per-command detail); `self-hosting.md` is the
  **journey** and links into it rather than duplicating.
- `.claude/skills/self-host/SKILL.md` + `.opencode/skills/self-host/SKILL.md`
  (new) — identical `self-host` Agent Skills; a runbook that maps the user's
  intent to the right `make setup` invocation. Auto-discovered by each tool when
  the project is opened; no install step.
- `README.md` — add a "Self-hosting" doc-table row and a one-liner in Quick start
  ("Deploy it: `make setup`"), and note the `self-host` agent skill.
- `CHANGELOG.md` — Unreleased entry on ship.

**Reuse, explicitly:** `docker-compose.prod.yml`, `docker-compose.tunnel.yml`,
`docker-compose.quick-tunnel.yml`, `infra/cloudflare/*.tf`,
`infra/cloudflare/terraform.tfvars.example`, `scripts/tunnel-verify.sh`, and the
`tunnel-quick|provision|up|verify|destroy` Makefile targets — all from 0005.

**What a reviewer must not get wrong:** the wizard must never write a secret to a
world-readable file or to stdout; must not overwrite an existing `AUTH_SECRET`
silently (doing so invalidates every existing session and password-reset token);
and the ingress target stays `http://app:3000` (Compose service name), never
`localhost`.

## Acceptance criteria

- [ ] `make setup` on a clean clone (quick mode) yields a working public
      `*.trycloudflare.com` URL, a seeded admin, and a green verify — no manual
      file editing.
- [ ] Automated mode, given a Cloudflare API token + account/zone IDs + hostname,
      provisions the tunnel and serves the app on that custom domain over HTTPS
      end to end.
- [ ] Re-running `make setup` is idempotent — existing `AUTH_SECRET` preserved
      (no silent overwrite), no duplicate DNS/tunnel, seed stays a no-op.
- [x] Missing prerequisite (Docker down / Compose too old / no `terraform` in
      automated mode) fails preflight with a specific, actionable message. —
      `scripts/setup.sh` preflight fails with a named cause and a next step for
      a missing Docker binary, a stopped daemon, and a missing Compose v2 plugin.
- [x] `.env` and `infra/cloudflare/terraform.tfvars` are created `0600`; no
      secret appears in stdout or the git tree. —
      `scripts/setup.sh` `chmod 600`s `.env` and writes the tfvars under
      `umask 177`.
- [ ] Non-interactive invocation (all inputs via env/flags) completes the same
      flow unattended.
- [x] `docs/self-hosting.md` walks a non-expert from clone to live domain and is
      linked from `README.md`.
- [ ] The `self-host` skill is present for both Claude Code and opencode, is
      discovered automatically on opening the project, and drives a successful
      `make setup` end to end (verified at least in quick mode).

> **Not verified (2026-09-09).** The open boxes above all need a live
> Cloudflare domain and a real end-to-end wizard run — resources only the
> operator has. They are accounted for, not forgotten: **Post-ship validation**
> below sets out the exact sequence that closes them.

## Post-ship validation

The code shipped in v0.14.0; the remaining unchecked criteria above are a
**full `make setup` run against a real Cloudflare domain**, which needs
resources only the operator has (a Cloudflare domain + API/tunnel token). The
sequence to close them out:

1. **Quick-mode smoke test** — `SETUP_MODE=quick SETUP_YES=1 make setup` (brief
   public `*.trycloudflare.com` exposure; tear down right after).
2. **Automated (or guided) mode against the real domain** → live
   `https://app.<domain>` with a seeded admin and a green `make tunnel-verify`.
3. **Exercise CD** ([0021](0021-continuous-deployment-self-hosted.md)) — set
   `APP_IMAGE` in `.env`, `make deploy`, then roll back by re-pinning `APP_TAG`.

Boot persistence and the self-hosted-runner CD path
([0022](0022-always-on-hardening-mac-mini.md), [0021](0021-continuous-deployment-self-hosted.md))
are already **verified live on the frank server**; this remaining item is the
one-time wizard run on a brand-new domain.

## Security & privacy

- Inherits 0005's posture: outbound-only tunnel, TLS terminates at Cloudflare,
  rate-limiting keyed on `CF-Connecting-IP`, scoped API token used only at
  provision time (runtime holds only the tunnel token).
- New surface is local secret handling: generate with `openssl`, write `0600`,
  never log, never commit (both target files already gitignored). Confirm before
  overwriting an existing `AUTH_SECRET` because rotation invalidates live
  sessions and outstanding email tokens.
- The wizard runs entirely on the operator's machine; it sends nothing anywhere
  except the Cloudflare API calls Terraform already makes in the automated path.

## Alternatives considered

- **Docs-only ("just follow deployment.md")** — status quo; the sequencing and
  the easy-to-miss `AUTH_URL`/S3 steps are exactly what trips people up.
- **A Node/TS interactive CLI** — richer prompts, but adds a build/runtime dep to
  a deploy-time tool that must run _before_ `pnpm install` is even guaranteed;
  bash keeps it dependency-free. (0005 already anticipated "the interactive wizard
  fallback" over a hand-rolled API script — this is that wizard, over Terraform.)
- **Expand `deployment.md` in place** instead of a new guide — keeps one file but
  conflates reference (every flag) with journey (do this, then this); splitting
  keeps each readable.
- **A hosted "deploy button"** (Render/Railway/Vercel-style) — off-thesis; this
  boilerplate's premise is portable, self-owned single-box hosting.

## Out of scope / future

- Non-interactive CD from CI, remote Terraform state backend, staging/multi-env
  routing, managed-Postgres provisioning, Cloudflare Access gating — all deferred
  (several already noted in 0005).
- A `make doctor` that diagnoses a _running_ deployment beyond `tunnel-verify`.

## References

- Builds directly on [0005 — Cloudflare Tunnel deployment](0005-cloudflare-tunnel-deployment.md)
  (Shipped, v0.4.0) and its artifacts: `docs/deployment.md`, `infra/cloudflare/`,
  `docker-compose.tunnel.yml`, `docker-compose.quick-tunnel.yml`, `Makefile`
  tunnel targets, `scripts/tunnel-verify.sh`.
- Related: [0009 — Automated backups](0009-automated-backups.md) (day-2 operations
  the guide links to).
- Will add on implementation: `scripts/setup.sh`, `Makefile` `setup:` target,
  `docs/self-hosting.md`, `.claude/skills/self-host/` + `.opencode/skills/self-host/`,
  README + CHANGELOG entries.
- [Anthropic Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview)
  — the shared `SKILL.md` format both Claude Code and opencode consume.
