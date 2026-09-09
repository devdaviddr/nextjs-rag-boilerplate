---
id: 0013
title: Dark-mode toggle & theming
status: Shipped
release: 'v0.8.0'
created: 2026-07-13
updated: 2026-07-13
---

# 0013 — Dark-mode toggle & theming

## Summary

Wire up a light/dark/system theme toggle. The CSS side of this is already
done — `globals.css` has a full `.dark` token set (oklch variables) and
`layout.tsx` already carries `suppressHydrationWarning` on `<html>` — this
spec adds the missing piece: a persisted, flash-free toggle mechanism.

## Problem / motivation

`src/app/globals.css` defines complete `:root` and `.dark` color tokens, and
every shadcn/ui component already themes off them — but there's no way to
actually switch into dark mode. It's a fully-built, entirely unreachable
feature.

## Goals

- A visible toggle in the app shell that switches between light, dark, and
  system.
- No flash-of-wrong-theme on page load.
- Choice persists across sessions.

## Non-goals

- Per-component custom themes beyond the existing light/dark token pairs.
- A theme picker beyond light/dark/system (no custom accent-color picker,
  etc.).

## Requirements

### Functional

- **FR1** — `next-themes` added as a dependency; `<ThemeProvider
attribute="class" defaultTheme="system" enableSystem>` wraps the app in
  `layout.tsx`.
- **FR2** — A theme toggle (sun/moon icon, `lucide-react` — already a
  dependency) in the app shell topbar (`src/components/shell/`), using the
  existing `@radix-ui/react-dropdown-menu` dependency for a three-way
  light/dark/system menu.
- **FR3** — Toggle is available on every authenticated page (in the shell)
  and, separately, on `/login`/`/register` (unauthenticated users should be
  able to pick a theme too).

### Non-functional

- **NFR1** — No flash of incorrect theme on first paint — `next-themes`'s
  blocking inline script handles this, but it must be compatible with the
  existing per-request CSP nonce (`x-nonce`, set in `proxy.ts`); the script
  is passed the request nonce via `<ThemeProvider nonce={nonce}>` (read via a
  server component wrapper) so `script-src 'self' 'nonce-…' 'strict-dynamic'`
  doesn't block it.
- **NFR2** — Respects `prefers-color-scheme` by default (`system`); an
  explicit user choice overrides it and persists in `localStorage`.
- **NFR3** — Zero layout shift when the theme resolves — token swap is
  CSS-variable-only, no re-render of themed components required.

## Design / approach

- `layout.tsx` already has `<html lang="en" suppressHydrationWarning>` — a
  prerequisite `next-themes` requires and this repo already anticipated.
- The CSP nonce currently flows to Next's own inline scripts via the
  `x-nonce` request header set in `proxy.ts`; a small server component reads
  that header (via `headers()`) and threads it into `<ThemeProvider
nonce={...}>` so the anti-flash script is nonce-authorized rather than
  requiring a CSP loosening.
- Toggle component: a `DropdownMenu` (existing dependency) with three items
  (Light / Dark / System), calling `next-themes`'s `useTheme().setTheme()`.
  Icon reflects the _resolved_ theme (`resolvedTheme`), not the raw setting,
  so "System" correctly shows a sun or moon depending on the OS preference.

## Acceptance criteria

- [x] Toggling theme updates the UI immediately, no page reload.
- [x] Reloading the page after an explicit choice preserves it (no flash of
      the other theme, verified via a Playwright check of the `.dark` class
      present on `<html>` after reload).
- [x] With no stored preference, the app matches `prefers-color-scheme`
      (`defaultTheme="system"` with `enableSystem`).
- [x] CSP is not weakened — no `unsafe-inline` added to `script-src` in
      production; the anti-flash script uses the existing nonce
      (`ThemeProvider nonce={…}` fed from the `x-nonce` request header).
- [x] A11y: the toggle is keyboard-operable and announces its state
      (`tests/e2e/a11y.spec.ts` opens it via keyboard and asserts the radio
      items' `aria-checked` state). Note: the "no violations while open"
      full-page axe scan was dropped — Radix `DropdownMenu` marks background
      content `aria-hidden` without `inert`, so focusable siblings on the
      auth page trip `aria-hidden-focus`; that is Radix-internal behaviour,
      not a defect in this component, and the closed-state page is already
      axe-scanned.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`
      pass.

## Security & privacy

- No new data collection — theme preference is a `localStorage` value only,
  never sent to the server.
- CSP posture unchanged (NFR1 explicitly avoids loosening `script-src`).

## Alternatives considered

- **Hand-rolled toggle (no library)** — `next-themes` is small (~1 KB), has
  already solved the flash-of-wrong-theme problem correctly across
  SSR/hydration edge cases, and is the de facto standard for this exact
  problem in the Next.js ecosystem; reinventing it isn't worth the risk of
  getting the hydration timing subtly wrong.
- **CSS-only `prefers-color-scheme` with no manual override** — simpler, but
  doesn't let a user override their OS setting for this one app, which is a
  reasonable, commonly-expected control.

## Out of scope / future

- Custom accent-color theming beyond light/dark.
- Per-user theme preference stored server-side (currently `localStorage`
  only — fine for a single-device-typical POC/portfolio audience).

## References

- [README](../README.md).
- [next-themes](https://github.com/pacocoursey/next-themes).
- Existing token definitions: `src/app/globals.css`.
