---
id: 0015
title: Web Push notifications
status: Shipped
release: 'v0.12.0'
created: 2026-07-13
updated: 2026-07-13
---

# 0015 — Web Push notifications

## Summary

Activate the Web Push hooks already stubbed (commented out) in
`public/sw.js`: subscribe/unsubscribe UI, a subscriptions table, and a
server-side send helper using VAPID keys. Ships as infrastructure plus one
worked example, since this boilerplate has no specific business event to
notify on by default.

## Problem / motivation

The service worker already carries `// self.addEventListener('push', ...)`
and `// self.addEventListener('notificationclick', ...)` as explicit
placeholders — this feature was designed for from the start
([0002](0002-pwa-and-app-shell.md)) but never built. A PWA that can be
installed to a home screen but never sends a notification is missing the one
capability that most differentiates it from a bookmark.

## Goals

- A user can opt in to push notifications from Settings.
- The server can push a notification to a specific user's subscribed
  device(s).
- Expired/revoked subscriptions are pruned automatically, not left to
  accumulate as dead rows.

## Non-goals

- A general-purpose notification/event system (topics, broadcast, scheduling)
  — this spec ships the primitive (subscribe + send), not a framework.
- Native push (iOS/Android app push via FCM/APNs) — Web Push only.

## Requirements

### Functional

- **FR1** — `web-push` npm package; `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/
  `VAPID_SUBJECT` (a `mailto:` contact) env vars, optional — the feature is
  inert without them.
- **FR2** — `pushSubscriptions` table (`id`, `userId` → `users.id`,
  `endpoint`, `p256dh`, `auth`, `createdAt`) — one user can have multiple
  subscriptions (multiple devices/browsers).
- **FR3** — Settings gains an "Enable notifications" toggle: requests
  `Notification.requestPermission()`, then
  `registration.pushManager.subscribe({ applicationServerKey: VAPID_PUBLIC_KEY })`,
  then POSTs the subscription to a `saveSubscription()` Server Action.
  Disabling calls `unsubscribe()` client-side and deletes the row.
- **FR4** — `sendPushNotification(userId, { title, body, url })` server
  helper: sends to every stored subscription for that user via `web-push`;
  any subscription that returns HTTP 410 (Gone) is deleted automatically.
- **FR5** — One worked example wired up end-to-end (not just the primitive):
  notify all admins when a new user self-registers — proving the send path
  actually works, consistent with this repo's "verified end to end, not just
  scaffolded" standard.
- **FR6** — Activate the existing `push`/`notificationclick` listeners in
  `public/sw.js`: show the notification on `push`, focus/open the relevant
  client on `notificationclick`.

### Non-functional

- **NFR1** — Only functions over HTTPS (already guaranteed via Cloudflare
  Tunnel) and requires the installed service worker (already in place since
  [0002](0002-pwa-and-app-shell.md)).
- **NFR2** — VAPID private key never reaches the client — server-only,
  alongside the existing `server-only`-guarded modules.
- **NFR3** — Sending is best-effort and non-blocking for the triggering
  action, mirroring the existing "email send failure never blocks the
  mutation" pattern from `sendEmail()`.

## Design / approach

- `src/lib/push/` mirrors the structure of `src/lib/email/`: a `server-only`
  client wrapper around `web-push`, a `send()` function that's a safe no-op
  when VAPID keys are unset, and call sites that never branch on
  configuration themselves.
- `saveSubscription`/`removeSubscription` Server Actions are rate-limited
  (reuse `rateLimit()`), same posture as other mutating actions.
- The service worker changes are additive — uncomment and flesh out the two
  existing stub listeners; no change to the existing cache/offline logic.
- `sendPushNotification` iterates a user's subscriptions and prunes 410s
  inline (no separate cleanup job needed — expiry is naturally discovered on
  next send attempt).

## Acceptance criteria

- [~] Toggling "Enable notifications" in Settings requests permission and
  persists a `push_subscriptions` row (`saveSubscription`). The toggle
  renders and is wired (screenshot); the actual subscribe needs a real push
  service + HTTPS + installed SW, so it's verified manually.
- [~] `sendPushNotification()` delivers a visible OS notification — the send
  path and payload are unit-tested (mocked `web-push`); real OS delivery is
  manual (needs a live push service).
- [x] A revoked subscription is pruned automatically on the next send (410 →
      row deleted), and a transient (500) error does NOT prune —
      `tests/unit/push.test.ts`.
- [x] The admin-notify-on-new-registration example is wired end-to-end
      (`registerAction` → `notifyRole('admin', …)`, best-effort/non-blocking);
      the send/prune it drives is unit-tested.
- [x] With no VAPID keys configured, the Settings panel doesn't render at all —
      feature is fully inert (`tests/e2e/push.spec.ts`).
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`
      pass.

Verification notes:

- Automated: send-to-all + 410-prune + non-410-no-prune + config gating
  (`tests/unit/push.test.ts`); panel-hidden-when-unconfigured
  (`tests/e2e/push.spec.ts`).
- Visual: the Notifications panel + Enable button render when VAPID is
  configured (screenshot, real generated keys).
- Manual (needs a live push service + HTTPS + installed SW, not automatable
  headlessly): the browser subscribe handshake and actual OS notification
  delivery. The server send path, 410 pruning, SW `push`/`notificationclick`
  handlers, and the admin-notify example are all in place and unit-verified.

## Security & privacy

- Push payloads should avoid sensitive content (they may be visible on a lock
  screen) — documented guidance in the module, not just left implicit.
- Subscription endpoints are per-user, ownership-checked on delete (same
  pattern as [0007](0007-file-uploads.md)'s file ownership checks).
- VAPID private key handled with the same care as `AUTH_SECRET` — `.env`
  only, never logged.

## Alternatives considered

- **Third-party push service (OneSignal, Firebase Cloud Messaging)** — more
  features, but a cloud dependency and another account to provision per
  fork; `web-push` + self-managed VAPID keys keeps this fully self-hosted,
  consistent with the rest of the roadmap.
- **Server-Sent Events / WebSocket "in-app" notifications instead** — useful
  for a different use case (live in-tab updates while the app is open); Web
  Push specifically covers the "notify even when the tab/app is closed" case
  the service worker was built for. Not mutually exclusive — could be a
  separate future spec.

## Out of scope / future

- In-app (SSE/WebSocket) live notifications.
- Notification preferences/categories beyond a single on/off toggle.
- Native mobile push.

## References

- [README](../README.md).
- Stubbed hooks: `public/sw.js` (from
  [0002 — PWA & responsive app shell](0002-pwa-and-app-shell.md)).
- [web-push (npm)](https://github.com/web-push-libs/web-push).
