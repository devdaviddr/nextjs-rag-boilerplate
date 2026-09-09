---
id: 0005
title: Cloudflare Tunnel deployment
status: Shipped
release: 'v0.4.0'
created: 2026-07-12
updated: 2026-07-12
---

# 0005 — Cloudflare Tunnel deployment

## Summary

Add an opt-in deployment path that exposes the existing Docker container on a
Cloudflare-managed domain via **Cloudflare Tunnel** — no open ports, no reverse
proxy, no certificate management. Offer three on-ramps (a zero-config demo, a
written guide, and one-command IaC) that all converge on the same runtime.

## Problem / motivation

Self-hosting the container currently means DIY reverse proxy + TLS + DNS + port
forwarding. Cloudflare Tunnel removes all of that with an outbound-only daemon,
but wiring it _correctly_ (real client IP, secure cookies behind a proxy,
least-privilege secrets) is easy to get wrong. It should be a first-class,
reproducible feature — not a copy-pasted snippet.

## Goals

- Deploy the unmodified app + Postgres behind a Cloudflare domain over HTTPS.
- One invariant runtime: a tunnel token + a DNS record →
  `docker compose --profile tunnel up`.
- Both a guided (manual) and an automated (IaC) path, provably equivalent.

## Non-goals

- Cloudflare Pages/Workers (serverless) deployment — a different architecture.
- Cloudflare Access / Zero Trust SSO (documented optional add-on).

## Requirements

### Functional

- **FR1** — `cloudflared` service (Compose overlay `docker-compose.tunnel.yml`)
  running a token-based named tunnel; app has **no published host ports** in
  this mode.
- **FR2** — A quick-tunnel overlay (`docker-compose.quick-tunnel.yml`) for an
  ephemeral `*.trycloudflare.com` URL with no Cloudflare account.
- **FR3** — Terraform module provisioning the tunnel, its ingress config, and the
  DNS record; outputs the runtime tunnel token.
- **FR4** — A `tunnel:verify` doctor usable after either the guided or automated
  path.

### Non-functional

- **NFR1** — Client IP for rate limiting comes from `CF-Connecting-IP` behind the
  tunnel (X-Forwarded-For is spoofable).
- **NFR2** — Auth issues secure cookies behind the proxy (`AUTH_URL`,
  `AUTH_TRUST_HOST`, `x-forwarded-proto`).
- **NFR3** — Least-privilege secrets: a scoped Cloudflare API token used **only**
  at provision time; runtime holds only the tunnel token.
- **NFR4** — Opt-in; zero impact on the default stack.

## Design / approach

Layered — right tool per layer, all converging on the Compose runtime:

- **Runtime** — `docker-compose.prod.yml` gains a `cloudflared` service behind
  `--profile tunnel` reading `CLOUDFLARE_TUNNEL_TOKEN`; drop the app's host port
  mapping so it's reachable only via the tunnel.
- **Provisioning (IaC)** — `infra/cloudflare/` Terraform (pinned provider)
  managing the tunnel + ingress (`hostname → http://app:3000`) + DNS record;
  outputs the sensitive tunnel token.
- **DX** — a `Makefile` (`tunnel-provision` / `tunnel-up` / `tunnel-verify` /
  `tunnel-destroy`) as thin wrappers.
- **App** — prefer `CF-Connecting-IP` in `src/lib/rate-limit.ts` callers; document
  `AUTH_URL`/`AUTH_TRUST_HOST` and verify secure cookies.
- **On-ramps** — quick tunnel (demo), guided dashboard steps in
  `docs/deployment.md`, and Terraform (automated) — the manual guide produces the
  _same_ token/DNS the automation does.

## Acceptance criteria

- [x] `make tunnel-quick` yields a working public `*.trycloudflare.com` URL —
      **verified live** (app + DB served over Cloudflare's edge).
- [x] `make tunnel-verify` confirms `/api/health` (db up) + HSTS + CSP — verified.
- [x] App has no published host ports in tunnel mode — `docker compose config`
      confirms `!reset []` clears them.
- [x] Rate limiting prefers `CF-Connecting-IP` — unit-tested.
- [ ] `make tunnel-provision && make tunnel-up` serves the app on a custom domain
      — needs a Cloudflare account/API token (module written, not applied here).
- [ ] `make tunnel-destroy` / `terraform destroy` removes everything — same.

> **Not verified (2026-09-09).** The two open boxes need a Cloudflare account
> and API token, as their own text says. The Terraform module is written and
> committed; it has not been applied here.

## Security & privacy

- Outbound-only tunnel; no inbound exposure. TLS terminates at Cloudflare.
- API token scoped to _Account → Cloudflare Tunnel:Edit_ and _Zone → DNS:Edit_.
- Rate limiting keyed on the trustworthy `CF-Connecting-IP`.

## Alternatives considered

- **Traefik + acme.sh + port-forward** — more moving parts, cert renewal, open
  ports.
- **Hand-rolled Node script over the CF API** — re-implements Terraform's
  idempotency/state/teardown; kept only as the interactive wizard fallback.
- **Config-file (locally-managed) tunnel** — extra credential files; token-based
  is simpler and IaC covers reproducibility.

## Out of scope / future

- Cloudflare Access SSO gate, multi-environment (staging) routing, remote
  Terraform state backend, CD from CI.

## References

- Prior discussion in project history (deployment brainstorm).
- Will add: `docs/deployment.md`, `infra/cloudflare/`, `Makefile`.
