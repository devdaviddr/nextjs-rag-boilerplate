---
id: 0003
title: Production security hardening
status: Shipped
release: 'v0.3.0'
created: 2026-07-12
updated: 2026-07-12
---

# 0003 — Production security hardening

## Summary

Close the gaps between "works" and "production-grade": rate-limit authentication,
add a nonce-based CSP and HSTS, fix a duplicate-registration race, make session
reads fail safe, and add the process guardrails (dependency updates, security
scanning, commit linting) expected of a serious repo.

## Problem / motivation

A security review found real gaps: auth endpoints were brute-forceable, there
was no CSP, registration could 500 on a concurrent duplicate, and
`getCurrentSession` swallowed _all_ errors (masking outages). Test breadth and
supply-chain hygiene were thin.

## Goals

- Rate limiting that cannot be bypassed by hitting the raw auth endpoint.
- A meaningful, app-compatible CSP plus standard hardening headers.
- Robust registration and session-read error handling.
- Automated dependency updates, code scanning, and commit standards.

## Non-goals

- Multi-instance/shared-store rate limiting (documented follow-up).
- Full RBAC or account lockout policies.

## Requirements

### Functional

- **FR1** — Cap login/registration attempts; friendly message in the UI.
- **FR2** — Duplicate registration returns a clean error, never a 500.
- **FR3** — Undecryptable session cookies read as signed-out; real errors surface.

### Non-functional

- **NFR1** — Nonce CSP with `strict-dynamic` (prod), HSTS, `X-Powered-By` off.
- **NFR2** — Rate limiting enforced in the credentials `authorize` callback
  (not just the server action) so the raw endpoint is covered.
- **NFR3** — Accessible mobile drawer (focus trap, Escape, focus restore).
- **NFR4** — CI runs a dependency audit; CodeQL scans on push/PR.

## Design / approach

- **Rate limiting** — `src/lib/rate-limit.ts` (in-memory fixed window), called
  from the server actions _and_ `authorize` (distinct keys, non-bypassable).
- **CSP** — per-request nonce generated in `src/proxy.ts`; HSTS + header hardening
  in `next.config.ts`.
- **Registration** — treat the unique index as source of truth; catch Postgres
  `23505`. Add a functional `lower(email)` unique index.
- **Sessions** — `getCurrentSession()` swallows only decode errors, rethrows the
  rest (with `unstable_rethrow` for Next control-flow signals).
- **A11y** — drawer becomes `role="dialog"` with focus management; skip link.
- **Ops** — structured-logging shim, graceful DB-pool shutdown, Renovate,
  CodeQL, commitlint, contributor docs, and new tests.

## Acceptance criteria

- [x] All hardening headers present (verified over HTTP).
- [x] The 9th rapid login attempt returns "too many attempts".
- [x] Direct POSTs to `/api/auth/callback/credentials` are rate limited.
- [x] Registering an existing email shows a clean error, not a 500.
- [x] 16 unit + 9 E2E green against a production build.

## Security & privacy

- Rate limiting blunts credential stuffing / brute force and Argon2 CPU-DoS.
- CSP limits injected-script impact; HSTS forces HTTPS.
- Client IP for limiting must come from a trusted header behind a proxy
  (see [0005](0005-cloudflare-tunnel-deployment.md) for the Cloudflare case).

## Alternatives considered

- **Static CSP with `unsafe-inline`** — weaker; rejected in favour of nonces.
- **Rate limiting only in the server action** — bypassable via the raw
  endpoint; rejected.

## Out of scope / future

- Upstash/Redis shared-store limiting, Sentry, email verification.

## References

- Release: `v0.3.0`.
- Docs: [`docs/architecture.md`](../docs/architecture.md#security-model).
