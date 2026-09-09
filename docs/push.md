# Web Push notifications

[← Back to README](../README.md)

**What this covers:** generating VAPID keys, turning on the notifications
toggle, sending a notification from server code, and what to keep out of the
payload.

Web Push lets your server put a notification on someone's device when your app
is not open — not even in a background tab. The browser vendor runs a push
service that holds a persistent connection to the device; your server hands that
service an encrypted message, and the service wakes the device's service worker
to display it.

The interesting part is what is _not_ here. There is no Firebase, no OneSignal,
no third-party SDK and no per-message cost. Your server identifies itself to the
push services with a keypair you generate yourself — that scheme is called
**VAPID**, Voluntary Application Server Identification — and talks to them
directly through the [`web-push`](https://github.com/web-push-libs/web-push)
library ([spec 0015](../specs/0015-web-push-notifications.md)).

Like OAuth and email, it is **opt-in**. Without the `VAPID_*` variables the send
helpers are no-ops and the Settings toggle is never rendered.

## Do you need this?

Almost certainly not for a first deployment, and nothing else depends on it.
Notifications earn their keep when something happens in your app while the user
is elsewhere and they would want to know — a slow document finishing processing,
a new user registering, a document shared with them.

**Cost to turn on:** two minutes, one command, three environment variables. No
account with anybody, and no ongoing cost. The real prerequisite is the one
below.

## Requirements

Web Push needs **HTTPS** and an **installed service worker**. The service worker
is the thing that receives the message and shows the notification, and it
registers in production builds only — so a `pnpm dev` session can never receive
a push, no matter how the keys are set.

Test against a production build (`pnpm build && pnpm start`) over HTTPS, or
against a real deployment. A Cloudflare Tunnel gives you HTTPS with no
certificate work — see [Deployment](deployment.md). The service worker itself is
covered in [PWA & App Shell](pwa.md).

## Setup

### 1. Generate a VAPID keypair

Once per deployment. Keep the output somewhere safe: browsers subscribe against
the public key you give them, so if you change the pair later, every device has
to subscribe again.

```bash
npx web-push generate-vapid-keys
```

### 2. Set all three variables and restart

```bash
VAPID_PUBLIC_KEY="B..."                     # safe to expose to the client
VAPID_PRIVATE_KEY="..."                      # server-only — never sent to the client
VAPID_SUBJECT="mailto:you@example.com"       # a contact URL for push services
```

All three are required. The feature checks for the complete set, so a partial
configuration stays off rather than half-working. `VAPID_SUBJECT` is how a push
service reaches you if your server misbehaves; a `mailto:` address is the usual
choice.

### 3. Turn it on per device

With the variables set, an **"Enable notifications"** card appears in Settings.
Each browser on each device subscribes separately — one user can have many
subscriptions — so every device the user wants notifications on has to be
enabled there.

## Verify it works

1. Run a production build over HTTPS and sign in.
2. Open **Settings**. The Notifications card is there; click **Enable** and
   accept the browser's permission prompt. The card should then read
   "Notifications are enabled on this device."
3. Trigger the worked example: register a second user from another browser or a
   private window. The app calls `notifyRole('admin', …)` on registration, so
   your admin device gets a notification. Click it — an existing tab on the
   target URL is focused, or a new one opens.

That worked example exists precisely so the send path is proven end to end
rather than shipped as an untested primitive.

## Reference — environment variables

| Variable            | Required | What it is                                                   |
| ------------------- | -------- | ------------------------------------------------------------ |
| `VAPID_PUBLIC_KEY`  | yes      | Public half of the keypair; sent to the browser to subscribe |
| `VAPID_PRIVATE_KEY` | yes      | Private half; signs each message. Server-only                |
| `VAPID_SUBJECT`     | yes      | Contact URL for push services, usually `mailto:…`            |

The full table for every variable in the app lives in
[Usage → Environment variables](usage.md#environment-variables).

## Sending a notification from your own code

Two helpers in `src/lib/push/`, both server-side:

```ts
import { notifyRole, sendPushNotification } from '@/lib/push'

// One user, every device they enabled.
await sendPushNotification(userId, {
  title: 'Something you care about happened',
  body: 'Tap to see it.',
  url: '/documents',
})

// Everyone holding a role.
await notifyRole('admin', { title: 'New user', body: 'sam@example.com joined' })
```

`url` is app-relative and decides where a click lands; it defaults to `/`.

Neither helper throws. If push is unconfigured they return immediately; if a
send fails, the failure is logged and the surrounding action carries on. That
mirrors `sendEmail()` — see [Email → Why it's built this way](email.md#why-its-built-this-way).

## How it works

Three moving parts: subscribe, send, receive.

**Subscribe.** The Settings panel
(`src/components/push/notifications-panel.tsx`) asks the browser for permission,
calls `pushManager.subscribe({ applicationServerKey })` with your public key,
and posts the result to the `saveSubscription` server action. Each
browser/device becomes a row in **`push_subscriptions`**, keyed by a unique
`endpoint` — the URL the push service gave you for that device. Saving upserts
on that endpoint, so re-subscribing or rotating browser keys updates the row
rather than erroring. Disabling calls `unsubscribe()` and deletes the row.

**Send.** `sendPushNotification` looks up every subscription for the user and
posts the encrypted payload to each endpoint. When a push service answers 404 or
410 — "this endpoint is gone" — the row is deleted on the spot, so dead
subscriptions from uninstalled apps and cleared browsers never accumulate.
`notifyRole` resolves a role name to its users and calls the first helper for
each.

**Receive.** The service worker (`public/sw.js`) handles the `push` event by
showing the notification, and `notificationclick` by focusing an already-open
tab on the target URL or opening a new one. It parses the payload defensively:
a malformed or absent body still shows something rather than throwing inside the
worker.

## Security and privacy

- **Payloads can appear on a lock screen.** Anyone holding the device can read
  the `title` and `body` without unlocking it. Put a subject line there, not the
  content — "Document ready", not the document's text.
- **The private key never leaves the server.** The browser only ever receives
  the public key, which is what it is for. Treat `VAPID_PRIVATE_KEY` exactly as
  you treat `AUTH_SECRET`: `.env` only, never logged, never committed.
- **Subscriptions are per-user and ownership-checked.** A delete only matches a
  row belonging to the current user _and_ the given endpoint, so one user cannot
  remove another's — the same ownership pattern as
  [file uploads](features.md#file-uploads). Saving a subscription is
  rate-limited like other mutating actions.
- **An endpoint can change hands.** Two people using one browser profile produce
  the same endpoint, so the upsert reassigns it to whoever subscribed most
  recently. That is deliberate: the alternative is sending one person's
  notifications to the other's session.

## Troubleshooting

**No Notifications card in Settings.** One of the three `VAPID_*` variables is
missing or empty. All three are required, and the app reads them at startup.

**The card says push is not supported.** Either the browser genuinely lacks
`PushManager`, or there is no service worker — which is the usual cause, because
the worker only registers in production builds. Run `pnpm build && pnpm start`.

**Enable fails with "Could not enable notifications on this device."** Permission
was denied, or the page is not in a secure context. Browsers remember a denial:
clear the site's notification permission in browser settings before retrying.

**Notifications stopped arriving on one device.** The subscription probably
expired and was auto-pruned after a 404 or 410 from the push service. Toggle the
Settings switch off and on to resubscribe.

**Nothing arrives anywhere after changing keys.** Existing subscriptions were
created against the old public key. Users have to toggle Settings off and on to
subscribe again — which is why the keypair is generated once and kept.

## Related

- [PWA & App Shell](pwa.md) — the service worker this builds on.
- [Features → Web Push](features.md#web-push-notifications-optional)
- [Spec 0015 — Web Push notifications](../specs/0015-web-push-notifications.md)

**Next:** [Self-hosting](self-hosting.md) — running the whole thing on your own
machine, with HTTPS, backups and automatic updates.
