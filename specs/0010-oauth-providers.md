---
id: 0010
title: OAuth providers (GitHub, Google)
status: Shipped
release: 'v0.10.0'
created: 2026-07-13
updated: 2026-07-13
---

# 0010 — OAuth providers (GitHub, Google)

## Summary

Add GitHub and Google sign-in alongside the existing Credentials flow, using
the Auth.js Drizzle adapter the schema was always designed for
(`src/db/schema.ts`'s `accounts`/`sessions`/`verificationTokens` tables have
been adapter-compatible since spec [0001](0001-project-foundation.md)). Each
provider is independently opt-in — configured only if its client ID/secret
env vars are present — matching the off-by-default pattern already
established for [email](0006-rbac.md).

## Problem / motivation

Portfolio visitors and POC testers shouldn't need to invent a password for a
throwaway account. GitHub/Google sign-in is table stakes for anything
public-facing, and the groundwork (adapter-compatible schema, a documented
integration sketch in spec 0006) is already there — it's just not wired up.

## Goals

- Sign in with GitHub or Google, each independently configurable.
- New OAuth sign-ins get bootstrapped into RBAC consistently with the
  existing first-user-is-admin / subsequent-users-are-member convention.
- Account linking is explicit and safe — an OAuth sign-in never silently
  merges into an existing credentials account with a matching email.

## Non-goals

- Additional providers beyond GitHub/Google in this pass (the adapter makes
  adding more mechanical once these two are proven).
- Passkeys/WebAuthn (the `authenticators` table exists for this; separate
  spec if pursued).
- Organization/team-scoped OAuth (e.g. GitHub org membership checks).

## Requirements

### Functional

- **FR1** — `DrizzleAdapter(db)` wired into `src/lib/auth/index.ts`, with
  `session.strategy` **explicitly kept `'jwt'`** (Auth.js defaults to
  `'database'` sessions once an adapter is present unless overridden — losing
  this would break the edge-only `proxy.ts` route protection, which reads the
  JWT with zero DB round-trips).
- **FR2** — `GitHub`/`Google` providers registered conditionally: each only
  added to the `providers` array if its `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET`
  (resp. `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`) env vars are both set.
- **FR3** — `/login` renders a "Continue with GitHub"/"Continue with Google"
  button only for configured providers, via a server-computed boolean prop
  (never leak the secret values themselves to the client).
- **FR4** — New OAuth sign-ins run the same role-bootstrap rule already
  sketched in [0006](0006-rbac.md#oauth-provider-integration): first user
  ever → `admin`; subsequent OAuth sign-ins → `member`.
- **FR5** — Settings gains a "Connected accounts" panel: list linked
  providers, link an additional provider while signed in, unlink a provider —
  blocked server-side if unlinking would leave the account with no password
  **and** no remaining linked provider (self-lockout prevention, same pattern
  as `admin-actions.ts`'s self-role-removal guard).

### Non-functional

- **NFR1** — `allowDangerousEmailAccountLinking` is **off** (the Auth.js
  default) for both providers. An OAuth sign-in whose email matches an
  existing credentials account does **not** auto-merge; the user sees a clear
  message to sign in with their password first, then link the provider from
  Settings. Auto-linking on unverified/attacker-controlled email is a known
  account-takeover vector — this is a deliberate, documented trade-off, not an
  oversight.
- **NFR2** — Zero behavior change for existing credentials-only deployments
  that don't configure any OAuth env vars.
- **NFR3** — `proxy.ts`'s edge JWT checks continue to require zero Node
  dependencies — the adapter (which needs the DB) is only ever touched in the
  Node runtime (`src/lib/auth/index.ts`), never in `config.ts`.

## Design / approach

- Provider registration in `src/lib/auth/index.ts`:

  ```ts
  const providers = [Credentials({ ... })]
  if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) {
    providers.push(GitHub({ allowDangerousEmailAccountLinking: false }))
  }
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    providers.push(Google({ allowDangerousEmailAccountLinking: false }))
  }
  ```

- `signIn` callback: on a new OAuth user (`isNewUser` or absence of any
  `userRoles` row), assign `admin` if `count(users) === 1` else `member` —
  same logic path as `db:seed`'s bootstrap, factored into a shared helper so
  it isn't duplicated.
- Role/session enrichment is provider-agnostic: the existing `jwt` callback in
  `src/lib/auth/index.ts` already fetches roles by `token.id` regardless of
  how the user signed in — no changes needed there.
- Login page provider buttons: a server component queries
  `isGithubConfigured()`/`isGoogleConfigured()` (thin wrappers over `env`,
  mirroring `isEmailEnabled()`) and passes booleans to the client login form —
  never the secrets.
- Env additions to `src/lib/env.ts` (all optional): `AUTH_GITHUB_ID`,
  `AUTH_GITHUB_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`.

## Acceptance criteria

- [x] With no OAuth env vars set, `/login` looks and behaves exactly as today
      (e2e `oauth.spec.ts` — buttons hidden, credentials form unchanged).
- [~] With GitHub configured, signing in via GitHub for the first time creates
  a user with no `hashedPassword` and the correct bootstrap role
  (`events.createUser` → `bootstrapNewUserRole`). **Logic implemented and
  UI verified with placeholder creds; the full provider round-trip needs
  real GitHub/Google secrets, so it's verified manually, not in CI** — a
  mock-OAuth harness was out of scope for this pass.
- [x] Signing in with an email matching an existing account does **not**
      silently link — `allowDangerousEmailAccountLinking: false` (default) and
      the documented `OAuthAccountNotLinked` message renders (e2e-covered).
- [~] Linking a second provider from Settings, and both then signing the same
  user in — UI/actions implemented and rendered (screenshots); full
  round-trip needs real provider creds (manual).
- [x] Unlinking the only remaining sign-in method is blocked server-side
      (guard in `unlinkProviderAction`; no-password + last-account check).
- [x] `session.strategy` stays `'jwt'` (inherited from `authConfig`, set
      explicitly with a comment); `proxy.ts` still imports only the edge
      `config.ts` — the adapter never enters the edge bundle (verified: build
      keeps Proxy/Middleware separate, all edge tests pass).
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`
      pass.

Verification notes:

- Automated: provider-config logic (`tests/unit/oauth-providers.test.ts`),
  no-provider regression + account-not-linked message (`tests/e2e/oauth.spec.ts`).
- Manual/visual: login provider buttons and the Settings "Connected accounts"
  panel render correctly with placeholder creds (screenshots). The GitHub/Google
  OAuth round-trip itself (create-user, link, unlink) requires real provider
  secrets and a callback URL, so it isn't part of CI; `[~]` items above are
  code-complete and structurally verified but not exercised end-to-end in an
  automated test.

## Security & privacy

- No auto-linking on email match (NFR1) — the primary risk this design
  addresses.
- OAuth `client_secret` values live only in `.env`, validated but never
  logged; never sent to the client.
- Unlink flow prevents self-lockout (FR5).
- GitHub/Google both verify email ownership before issuing the identity token,
  so once explicit linking is used, the link itself is trustworthy — the risk
  is specifically in _implicit_ linking, which this design avoids.

## Alternatives considered

- **`allowDangerousEmailAccountLinking: true`** — simpler UX (one less click),
  but the security trade-off (name says it all) isn't appropriate for a
  boilerplate whose forks may handle real user data.
- **Database session strategy** (Auth.js's default once an adapter is added)
  — would simplify some things but breaks the edge-only, zero-DB-round-trip
  route protection this app already relies on; explicitly rejected (FR1).

## Out of scope / future

- Additional providers (Discord, Apple, etc.) — mechanical once this ships.
- Passkeys/WebAuthn.
- Org/team-scoped provider claims.

## References

- [README](../README.md).
- Builds on the integration sketch in
  [0006 — RBAC § OAuth Provider Integration](0006-rbac.md#oauth-provider-integration)
  and the adapter-compatible schema from
  [0001](0001-project-foundation.md).
- [Auth.js Drizzle adapter docs](https://authjs.dev/getting-started/adapters/drizzle).
