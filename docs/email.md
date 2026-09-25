# Email (setup, verification & password reset)

This page covers pointing the app at an SMTP server, testing it locally without
sending real mail, and what the three flows that need email do: invites,
password reset and address verification.

Three things in this app send a message to a person: an admin inviting
someone, a user who has forgotten their password, and a new registration that
needs its address confirmed. All three need an outbound mail server. None of
them is essential, so the whole feature is off by default.

When it is off, `sendEmail()` becomes a no-op that logs at debug and returns
without throwing, so nothing that would have sent a message can fail because
email is unconfigured. Registration still works and invites still create
accounts. Only the message goes missing, and the parts of the UI that depend on
one say so.

## Do you need this?

You don't need it to learn the rest of the repo. The document chat has nothing
to do with email, and a single-user deployment where you create your own account
can run without it indefinitely.

Turn it on when other people will use your deployment. Without it there is no
self-service password reset (`/forgot-password` tells the user to contact an
administrator, which means you), and invited users have to be handed their
claim link out of band.

Turning it on takes five minutes and an SMTP account. Any provider will do.
Resend, SendGrid, Mailgun, SES, Postmark and Gmail all expose SMTP credentials,
and the transport is plain `nodemailer` over SMTP with nothing provider-specific
in the code ([spec 0011](../specs/0011-email-verification-password-reset.md)).

## Setup

### 1. Test locally first, with a mail catcher

Before you sign up for anything, run a fake SMTP server that catches every
message and shows it in a web UI. Nothing leaves your machine, and the links in
each message work. [Mailpit](https://github.com/axllent/mailpit) is already a
service in `docker-compose.yml`:

```bash
pnpm docker:mail
```

That publishes SMTP on port 1025 and a web UI on port 8025. Point the app at it:

```bash
EMAIL_ENABLED="true"
EMAIL_FROM="dev@example.com"
SMTP_HOST="localhost"
SMTP_PORT="1025"
SMTP_SECURE="false"
```

Restart the app, then open <http://localhost:8025> to read whatever it sends.

### 2. Point it at a real provider

For a deployment other people use, swap in your provider's SMTP details:

```bash
EMAIL_ENABLED="true"
EMAIL_FROM="no-reply@yourdomain.com"
SMTP_HOST="smtp.yourprovider.com"
SMTP_PORT="587"
SMTP_USER="..."
SMTP_PASSWORD="..."
SMTP_SECURE="false"   # true for port 465 (implicit TLS); false for 587 (STARTTLS)
```

`SMTP_SECURE` is only an override, since port 465 turns implicit TLS on by
itself. Set it explicitly when your provider does something unusual.

### 3. Set `APP_URL` to your real origin

Every link the app emails is built from `APP_URL`, which defaults to
`http://localhost:3000`. If you leave the default on a deployed app, your users
get password-reset links pointing at their own laptop. Set it to the origin
people browse to:

```bash
APP_URL="https://app.example.com"
```

### 4. Restart

The environment schema fails fast at boot if `EMAIL_ENABLED=true` while
`EMAIL_FROM`, `SMTP_HOST` or `SMTP_PORT` is missing. A half-configured mailer
shows up as a startup error right away, instead of as a message that silently
disappears three weeks later.

## Verify it works

With Mailpit running and the app restarted:

1. Register a new account. A verification message should appear in the Mailpit
   UI within a second or two.
2. Click the link in it. You land on `/verify-email` and the account is marked
   verified.
3. Sign out, go to `/forgot-password`, and submit that address. A reset message
   arrives; its link opens `/reset-password`, and the new password works on the
   next sign-in.

If nothing arrives, check the app logs. A send failure is logged with the
recipient and subject instead of thrown, so the evidence is there even though
the surrounding action succeeded.

## Reference — environment variables

| Variable                     | Default                 | What it does                                                     |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `EMAIL_ENABLED`              | `false`                 | Master switch; everything below is ignored unless this is `true` |
| `EMAIL_FROM`                 | —                       | The From address; required when enabled                          |
| `SMTP_HOST`                  | —                       | Mail server hostname; required when enabled                      |
| `SMTP_PORT`                  | —                       | `587` (STARTTLS) or `465` (implicit TLS); required when enabled  |
| `SMTP_USER`                  | —                       | Username, if your provider needs auth                            |
| `SMTP_PASSWORD`              | —                       | Password, if your provider needs auth                            |
| `SMTP_SECURE`                | `false`                 | Force implicit TLS; automatically true on port 465               |
| `REQUIRE_EMAIL_VERIFICATION` | `false`                 | Turns on the soft gate described below                           |
| `APP_URL`                    | `http://localhost:3000` | Origin the emailed links point at                                |

The full table for every variable in the app lives in
[Usage → Environment variables](usage.md#environment-variables).

## What each flow does

### Invite links

An admin creates a passwordless account, and the invitee receives a single-use
link and sets their own password. The full description is in
[Features → Invite claim](features.md#invite-based-account-claim).

### Password reset

1. The user visits `/forgot-password` and submits their email address.
2. The response is always the same ("If an account exists for that email,
   we've sent a password reset link"), whether or not that address is
   registered. Only accounts that have a password are sent anything. An
   OAuth-only account has no password to reset and gets the same reply.
3. The emailed link carries a single-use token that expires after one hour.
   Only its SHA-256 hash is stored, scoped by `purpose` so it cannot be replayed
   as a verification token. Issuing a new one clears the previous one, so only
   the latest link works.
4. `/reset-password` consumes the token, sets the new password, and redirects to
   login. Both endpoints are rate-limited per IP and address.

When email is disabled, `/forgot-password` says so instead of pretending to
send: "Email isn't configured for this app — contact an administrator to reset
your password".

### Email verification and the soft gate

When email is on, a verification message goes out at registration, and users can
resend it from Settings. The link is good for 24 hours. Confirming it sets
`users.email_verified`.

That alone changes nothing about what a user may do. Setting
`REQUIRE_EMAIL_VERIFICATION=true` adds a **soft gate**, which nudges users to
verify without blocking them:

```bash
REQUIRE_EMAIL_VERIFICATION="false"   # default
```

- Unverified users see a banner with a "Resend verification email" button.
- Admin mutations are refused server-side until they verify
  (`requireEmailVerifiedIfEnforced`).
- They are not locked out of the app, and ordinary use continues. An app that
  needs a hard gate can extend the role-required map in `src/proxy.ts`.

The flag is ignored unless email is enabled. Otherwise nobody could ever verify,
and turning it on would lock out every account at once.

> OAuth users are verified already. [GitHub and Google](oauth.md) confirm
> email ownership before issuing their token, so an account created through a
> provider has `email_verified` set at creation and the soft gate skips it.

## Why it's built this way

Sending must never break the action that triggered it. Mail servers are often
slow, down or misconfigured, so `sendEmail()` catches its own failures, logs
them, and returns `{ sent: false }` instead of throwing. Creating a user
succeeds even when the invite bounces. [Web Push](push.md) uses the same
pattern for the same reason.

Configuration errors fail loudly and runtime errors fail quietly, on purpose. A
missing `SMTP_HOST` is your mistake and takes seconds to fix, so the app refuses
to start. A refused connection at 3am shouldn't cost a user their registration,
so it is logged and swallowed.

Nodemailer is imported lazily. The transport module is loaded inside
`sendEmail()` only after the enabled check passes, so a deployment with email
off never pulls `nodemailer` into a bundle, and it never gets near the edge
runtime, which could not run it.

Every response has the same shape whether or not the account exists. A
password-reset form that says "no such user" hands out a list of your
registered addresses. The reset, invite and verify flows answer identically for
a real account and an unknown one, matching the anti-enumeration behaviour of
registration and sign-in.

## Security notes

- Tokens are stored as SHA-256 hashes, compared in constant time, single-use,
  and scoped by `purpose` so one kind cannot be replayed as another.
- Anti-enumeration response shapes match the rest of the app (registration,
  invite claim).
- Session revocation on password reset is out of scope, because JWT sessions
  are not server-revocable today. **Resetting a password does not sign other
  browsers out.** This is a documented limitation, explained in
  [Architecture → Session strategy & revocation](architecture.md#session-strategy--revocation).

## Troubleshooting

The app won't start after enabling email: that is the fail-fast check. The
error names the missing variable: `EMAIL_ENABLED=true` requires `EMAIL_FROM`,
`SMTP_HOST` and `SMTP_PORT`.

No error, but no mail either: email is probably still off. `sendEmail()`
logs "Email disabled — skipping send" at debug level; set `LOG_LEVEL="debug"`
and look for it. If it is not there, look for "Email send failed" instead,
which carries the provider's error.

The links in the email point at localhost: `APP_URL` is unset on the
deployment. It defaults to `http://localhost:3000`, and every reset and
verification link is built from it.

TLS handshake errors mean the port and mode disagree. Use `587` with
`SMTP_SECURE="false"` (STARTTLS) or `465` with `SMTP_SECURE="true"` (implicit
TLS).

Users say the reset link is expired: reset tokens last one hour and
verification tokens 24 hours, and requesting a new one invalidates the old one.
A user who clicks "resend" twice and then opens the first mail sees this.

## Related

- [OAuth (GitHub & Google)](oauth.md): provider sign-in, which works alongside
  password reset.
- [Spec 0011: Email verification & password reset](../specs/0011-email-verification-password-reset.md)

Next: [PWA & App Shell](pwa.md), on how the app installs to a home screen and
keeps working when the network drops.
