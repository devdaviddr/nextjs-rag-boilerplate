# OAuth (GitHub & Google)

[← Back to README](../README.md)

**What this covers:** adding "Continue with GitHub" and "Continue with Google"
buttons to the sign-in page, linking a provider to an account that already
exists, and why the app refuses to merge two accounts on its own.

Out of the box this app signs people in with an email address and a password.
OAuth adds a second way in: the user clicks a button, proves to GitHub or Google
that they are who they say they are, and comes back with a verified email
address. You never see or store their password.

Both providers are **opt-in**, and independently so. Each one wires itself up
only when its two environment variables are present. A fork with neither set
behaves exactly like the password-only default — the buttons are not hidden by
CSS, they are never rendered, because the provider was never added.

## Do you need this?

No. Nothing else in the boilerplate depends on it. The knowledge-base and chat
features work identically whichever way a user signed in, because OAuth is not
a parallel login system — it is two extra providers on the same Auth.js instance
and the same `users` table that password sign-in already uses. Roles, sessions,
and every permission check downstream are provider-agnostic.

Turn it on when you would rather not be responsible for storing passwords, or
when your users already have a GitHub or Google account and you want sign-up to
be one click. Skip it while you are learning the RAG side of the repo.

**Cost to turn on:** about ten minutes per provider. You need a free account
with the provider, two environment variables, and a restart. There is no code
change and no migration — the `users` and `accounts` tables are already there
([spec 0010](../specs/0010-oauth-providers.md)).

## Setup

Do this once per provider. The two providers are independent: you can enable
GitHub alone, Google alone, or both.

### 1. Know your callback URL

Every OAuth provider needs to be told where to send the user back to. That
address is fixed by Auth.js and looks like this:

```
GitHub → {APP_URL}/api/auth/callback/github
Google → {APP_URL}/api/auth/callback/google
```

`{APP_URL}` is your public origin — the `APP_URL` environment variable, which
defaults to `http://localhost:3000` in local development. So on your laptop the
GitHub callback is literally
`http://localhost:3000/api/auth/callback/github`. Providers match this string
exactly, so register the one for the environment you are about to test.

On a real host, set `AUTH_URL` to that same origin as well. `APP_URL` is what
you build share cards, sitemap entries and email links from; `AUTH_URL` is what
Auth.js resolves its own callback URLs against. Behind a proxy, keep
`AUTH_TRUST_HOST="true"` so the forwarded host is honoured. Leave `AUTH_URL`
unset in production and the redirect can land on the wrong origin.

### 2. Register the app with GitHub

1. **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.**
2. **Homepage URL:** your `APP_URL`. **Authorization callback URL:**
   `{APP_URL}/api/auth/callback/github`.
3. Create it, copy the **Client ID** → `AUTH_GITHUB_ID`, generate a **client
   secret** → `AUTH_GITHUB_SECRET`.

### 3. Register the app with Google

1. **Google Cloud Console → APIs & Services → Credentials → Create credentials
   → OAuth client ID** (configure the consent screen first if prompted).
2. **Application type:** Web application.
3. **Authorized redirect URI:** `{APP_URL}/api/auth/callback/google`.
4. Copy the **Client ID** → `AUTH_GOOGLE_ID` and **Client secret** →
   `AUTH_GOOGLE_SECRET`.

### 4. Set the variables and restart

Put the id and secret for each provider you registered into `.env`, then restart
the app. A provider needs **both** of its values — one on its own does nothing.

```bash
# GitHub
AUTH_GITHUB_ID="..."
AUTH_GITHUB_SECRET="..."

# Google
AUTH_GOOGLE_ID="..."
AUTH_GOOGLE_SECRET="..."
```

## Verify it works

1. Open `/login`. A "Continue with …" button appears for each configured
   provider, and only for those. If you see no buttons, the app did not pick up
   the variables — see [Troubleshooting](#troubleshooting).
2. Click one and complete the provider's consent screen. You should land back in
   the app, signed in.
3. Open **Settings → Connected accounts**. The provider you just used is listed
   as linked.

On a brand-new deployment, the very first account created this way becomes
`admin`; every account after it becomes `member`. That happens in Auth.js's
`events.createUser`, so an OAuth-only deployment still has a working
administrator without any manual database work. Roles come from `pnpm db:seed` —
if seeding never ran, the role assignment logs an error and the user is created
without a role rather than failing the sign-in.

## Reference — environment variables

| Variable             | Required        | What it is                                                                                                               |
| -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_GITHUB_ID`     | for GitHub      | OAuth App client id from GitHub                                                                                          |
| `AUTH_GITHUB_SECRET` | for GitHub      | OAuth App client secret from GitHub                                                                                      |
| `AUTH_GOOGLE_ID`     | for Google      | OAuth client id from Google Cloud Console                                                                                |
| `AUTH_GOOGLE_SECRET` | for Google      | OAuth client secret from Google Cloud Console                                                                            |
| `AUTH_URL`           | for a real host | Canonical URL Auth.js resolves its own callback URLs against — set it in production                                      |
| `AUTH_TRUST_HOST`    | behind a proxy  | `"true"` lets Auth.js trust the forwarded host header                                                                    |
| `APP_URL`            | for a real host | Public origin used for share cards, robots/sitemap and email links — and the origin you register the callback URLs under |

The full table for every variable in the app lives in
[Usage → Environment variables](usage.md#environment-variables).

## Account linking, and the "already exists" message

Say someone registered with `sam@example.com` and a password, and later clicks
"Continue with Google" using that same address. Should the app treat those as
one account?

It does not — not automatically. Auto-linking on a matching email is off
(`allowDangerousEmailAccountLinking: false`, set explicitly rather than left to
the default). Instead they see:

> An account with this email already exists. Sign in with your password first,
> then link this provider from Settings.

Linking is a deliberate act: sign in the way you already can, then
**Settings → Connected accounts → Link**. From then on either route signs you
into the same account.

Unlinking is blocked server-side when it would leave you with no way back in —
no password **and** no other linked provider. You get an error rather than a
locked account:

> This is your only sign-in method. Set a password or link another provider
> before unlinking it.

## Why it's built this way

**Implicit linking is an account-takeover vector.** If the app merged accounts
whenever the email addresses matched, then anyone who could get a provider to
issue a token for `sam@example.com` would land inside Sam's existing account. An
explicit link is safe for exactly the opposite reason: GitHub and Google both
verify email ownership before issuing a token, so once a signed-in user chooses
to attach a provider, the attachment is trustworthy. The risk was never in the
provider — it was in linking without asking.

**Sessions stay JWT even though an adapter is present.** The Drizzle adapter is
what persists OAuth users and their `accounts` rows. Auth.js would normally flip
to database sessions as soon as an adapter appears, and that would quietly break
the edge route protection in `src/proxy.ts`, which reads the session from the
JWT with zero database round-trips. The session strategy is therefore pinned to
`'jwt'` in `src/lib/auth/index.ts`. See
[Architecture → Authentication design](architecture.md#authentication-design).

**OAuth users are created already-verified.** The providers confirm the email
before issuing their token, so `events.createUser` sets `email_verified` at
creation. Without that, an OAuth user would be nagged forever by the
verification gate described in [Email](email.md) for an address that was
verified before they ever reached your app.

**Secrets never reach the browser.** The client secrets live in `.env`, are
validated at boot, and are never logged. The login page is handed booleans —
`isGithubConfigured()` and `isGoogleConfigured()` — not values, which is also
why an unconfigured provider renders nothing at all.

## Troubleshooting

**No "Continue with …" button on the login page.** The provider is only added
when both of its variables are set and non-empty. Check for a typo in the
variable name, confirm the values are in the `.env` the app actually loads, and
restart — provider assembly happens at startup, not per request.

**The provider rejects the redirect ("redirect_uri mismatch").** The callback
URL registered with GitHub or Google must match the one the app sends,
character for character, including scheme, port and trailing path. A
localhost app registered against a production URL fails here. Register a second
OAuth app for local development rather than editing the production one.

**"An account with this email already exists."** This is the deliberate refusal
described above, not a bug. Sign in with the existing method, then link the
provider from Settings.

**Unlink is refused.** You are trying to remove your only way in. Set a password
or link a second provider first.

## Related

- [Features → Access control (RBAC)](features.md#access-control-rbac) — what the
  bootstrap `admin` role actually unlocks.
- [Spec 0010 — OAuth providers](../specs/0010-oauth-providers.md)

**Next:** [Email](email.md) — the other half of account handling: verification
links and password reset, which OAuth sits alongside.
