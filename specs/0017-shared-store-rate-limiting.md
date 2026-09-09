---
id: 0017
title: Shared-store rate limiting (Upstash)
status: Proposed
release: '—'
created: 2026-07-13
updated: 2026-07-13
---

# 0017 — Shared-store rate limiting (Upstash)

## Summary

Swap the in-memory rate limiter for a shared Redis-backed store
(`@upstash/ratelimit`) — **only if and when** a specific deployment of this
boilerplate runs as more than one instance. This spec is deliberately written
but not scheduled: the default deployment model this roadmap targets (one
Mac mini, one Docker Compose stack) has no instance to share state across, so
building this speculatively would be exactly the kind of infrastructure this
roadmap says to avoid.

## Problem / motivation

`src/lib/rate-limit.ts` is explicit about its own limitation: "Good enough
for a single instance... For serverless or multi-instance deployments, swap
the store for a shared backend." Today every deployment target in this
roadmap ([0005](0005-cloudflare-tunnel-deployment.md)'s Cloudflare Tunnel,
running one `app` container on one host) is single-instance, so the in-memory
limiter is not a bug — it's the correct choice for the stated goal. This spec
exists so the swap is a known, scoped quantity if that ever changes, not a
reason to build it now.

## Goals (if implemented)

- Rate limits enforced consistently across N app instances sharing one Redis
  store.
- Zero call-site changes — every existing caller of `rateLimit()` keeps
  working unmodified.
- Falls back to the current in-memory behavior when unconfigured, so this
  remains a strict opt-in.

## Non-goals

- Any change to rate-limit _policy_ (limits/windows) — this is a storage
  swap only.
- Implementing this now, for this roadmap's default deployment target — see
  Summary. This spec should not be picked up unless a specific fork actually
  needs horizontal scaling.

## Requirements

### Functional

- **FR1** — `rateLimit(key, limit, windowMs, now?)` in
  `src/lib/rate-limit.ts` keeps its exact current signature and return shape
  (`RateLimitResult`) — this is an explicit existing design constraint in the
  file's own docstring, and every caller (`checkAdminRateLimit`, the
  Credentials `authorize` callback, auth server actions) is unaffected.
- **FR2** — When `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are
  both set, `rateLimit()` delegates to `@upstash/ratelimit` against that
  store; when unset, the existing in-memory `Map` implementation is used
  unchanged.
- **FR3** — `resetRateLimit()` (currently a test-only helper) gets an
  Upstash-backed equivalent so the existing test suite doesn't need two
  divergent code paths for setup/teardown.

### Non-functional

- **NFR1** — No latency regression for the default (in-memory,
  single-instance) path — the Upstash branch must be a genuinely separate
  code path, not a wrapper that always round-trips to Redis.
- **NFR2** — Zero new required env vars — both Upstash vars are optional,
  preserving the zero-config default this whole roadmap is built around.

## Design / approach

- A thin adapter interface (`RateLimitStore`) with two implementations — the
  existing in-memory `Map`, and a new Upstash-backed one — selected once at
  module load based on whether the Upstash env vars are present. `rateLimit()`
  itself becomes a two-line dispatch to whichever store is active; all
  existing logic (fixed-window counting) moves into the in-memory
  implementation unchanged.
- Upstash's REST-based Redis (not a persistent TCP connection) is chosen
  specifically because it works from edge runtimes too — relevant if rate
  limiting is ever needed inside `proxy.ts` itself, which today only runs
  auth/RBAC/CSP logic, not rate limiting.

## Acceptance criteria (if implemented)

- [ ] With no Upstash env vars set, behavior and performance are
      byte-identical to today (regression-tested).
- [ ] With Upstash configured, two separate app instances sharing the same
      Redis store enforce a combined limit correctly (integration-tested
      against a real or emulated Upstash instance).
- [ ] All existing rate-limit unit tests pass against both store
      implementations via a shared test suite (parameterized, not
      duplicated).
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass.

## Security & privacy

- No new PII stored — rate-limit keys are already IP/email-derived strings,
  unchanged by this spec.
- Upstash REST token is a secret, `.env`-only, same handling as other
  provider credentials in this codebase.

## Alternatives considered

- **Redis (self-hosted, e.g. a `redis` Docker service)** — avoids a third-party
  dependency, but adds a stateful service to babysit for a feature this
  roadmap doesn't currently need at all; Upstash's serverless REST model
  means zero ops if this is ever actually implemented, which fits better
  given the conditional nature of this spec.
- **Do nothing / leave the docstring as the only guidance** — reasonable
  too; this spec exists mainly so the shape of the eventual change is
  pre-agreed rather than designed under pressure if a fork suddenly needs
  it.

## Out of scope / future

- A global per-IP login cap across accounts (credential-stuffing defense) —
  called out as a good next step in the existing `rate-limit.ts` docstring,
  but orthogonal to the storage-backend question this spec addresses.

## References

- Off the schedule entirely (see the [spec index](README.md)) for the single-box
  deployment model — this spec is the only record of the eventual change.
- Existing constraint documented in `src/lib/rate-limit.ts`'s own docstring.
- [`@upstash/ratelimit`](https://github.com/upstash/ratelimit).
