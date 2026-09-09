---
id: 0002
title: PWA & responsive app shell
status: Shipped
release: 'v0.2.0'
created: 2026-07-11
updated: 2026-07-12
---

# 0002 — PWA & responsive app shell

## Summary

Make the app installable and offline-resilient, and give authenticated routes a
minimal, borderless, responsive shell (sidebar + topbar) that works across
desktop, mobile, and installed-PWA contexts — with no new runtime dependencies
and no change to the Turbopack build.

## Problem / motivation

The foundation had no app chrome and wasn't installable. A boilerplate should
ship a credible, responsive layout and PWA support without dragging in a
Webpack-only service-worker plugin (which would conflict with Turbopack).

## Goals

- Installable PWA with an offline fallback.
- A responsive shell usable on phones and desktops and in standalone mode.
- Stay entirely on Turbopack; no extra runtime deps.

## Non-goals

- Push notifications (hooks only).
- Offline editing / background sync.

## Requirements

### Functional

- **FR1** — Web manifest, icon set, install prompt, offline page.
- **FR2** — Service worker registered in production only.
- **FR3** — Sidebar on desktop; off-canvas drawer on mobile; sticky topbar.

### Non-functional

- **NFR1** — SW must **never** cache authenticated or API responses.
- **NFR2** — Respect PWA safe-area insets (notch).
- **NFR3** — No Webpack-only tooling.

## Design / approach

- **Hand-rolled `public/sw.js`**: cache-first for static assets, network-only
  for navigations (with `/offline` fallback), never cache `/api/*`.
- `src/app/manifest.ts`, generated icons (`scripts/gen-icons`), `viewport`/
  `appleWebApp` metadata, install prompt + SW register components.
- **App shell** in `src/components/shell/`; data-driven nav from
  `src/lib/shell/nav.ts`; `env(safe-area-inset-*)` handling.
- Also folds in **error boundaries** (`error.tsx`, `global-error.tsx`,
  `not-found.tsx`) and a resilient `getCurrentSession()` — the fix for a
  Next.js 16 + Turbopack global-error crash on an undecryptable cookie.
- Repo hygiene: README restructured into `docs/`; MIT license added.

## Acceptance criteria

- [x] Lighthouse "Installable" passes; `/offline` renders when disconnected.
- [x] SW never serves cached `/dashboard` or `/api/*`.
- [x] Shell is usable at mobile and desktop widths; drawer toggles.
- [x] A stale/undecryptable session cookie no longer 500s the app.

## Security & privacy

- Strict SW caching prevents leaking one user's authenticated content to the
  next person on a shared device.

## Alternatives considered

- **Serwist / next-pwa** — require a Webpack build step; rejected to keep
  Turbopack for both dev and build.

## Out of scope / future

- Web Push (see `public/sw.js` hooks), richer install UI, screenshots.

## References

- Release: `v0.2.0`.
- Docs: [`docs/pwa.md`](../docs/pwa.md).
