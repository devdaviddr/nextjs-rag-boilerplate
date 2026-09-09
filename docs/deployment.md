# Deployment — Cloudflare Tunnel

[← Back to README](../README.md)

**What this covers:** the three ways to put this app on a public HTTPS address
with a Cloudflare Tunnel, and how to drive each one by hand.

A tunnel solves a specific problem. Your app is listening on port 3000 inside
Docker, on a machine sitting behind a home router or a firewall. To reach it from
the internet the usual answer is to forward a port, run a reverse proxy, and keep
a TLS certificate renewed. Every one of those is a thing that can break, and the
open port is a thing that can be attacked.

A **Cloudflare Tunnel** turns that inside out. You run a small daemon,
`cloudflared`, alongside the app. It dials **out** to Cloudflare's edge and keeps
that connection open. When someone visits your domain, Cloudflare terminates TLS
at its edge and pushes the request **down the connection you already opened**, to
the app container on the internal Docker network. Your host opens no inbound
port, runs no reverse proxy, and manages no certificate.

The production stack in [`docker-compose.prod.yml`](../docker-compose.prod.yml)
— app, database, migrator, MinIO and the backup sidecars — is unchanged by any of
this. The tunnel is an opt-in overlay layered on top.

> In tunnel modes the app has **no published host ports** — it's reachable only
> through the tunnel.

## Which path do I want?

All three end at the same runtime. They differ only in who creates the tunnel.
These are the same three modes `make setup` offers as Quick, Guided and
Automated in [Self-hosting](self-hosting.md#choose-your-mode). The A/B letters
below are the historical names of the two named-tunnel paths, and the rows are
ordered easiest-first rather than alphabetically.

| Path                                                       | Command                                   | You need                  | Good for                        |
| ---------------------------------------------------------- | ----------------------------------------- | ------------------------- | ------------------------------- |
| **Quick tunnel**                                           | `make tunnel-quick`                       | ❌ no Cloudflare account  | A demo link in 60 seconds       |
| **[Guided](#option-b--guided-dashboard)** (Option B)       | dashboard + `make tunnel-up`              | ✅ a domain on Cloudflare | Your own domain, clicked once   |
| **[Automated](#option-a--automated-terraform)** (Option A) | `make tunnel-provision && make tunnel-up` | ✅ + a scoped API token   | Reproducible, torn down as code |

If you would rather answer a few prompts than run these targets yourself,
[`make setup`](self-hosting.md) wraps all three in a wizard and also seeds and
verifies the deployment. This page is the manual route — the same primitives, one
command at a time.

## Prerequisites

- Docker + Docker Compose (v2.24+ — the deploy compose files use a newer
  Compose merge feature).
- A `.env` with at least `AUTH_SECRET` and `DATABASE_URL` (see [`.env.example`](../.env.example)).
- For named tunnels: a domain on Cloudflare and (for the automated path) a
  scoped API token — **Account → Cloudflare Tunnel: Edit**, **Zone → DNS: Edit**.

## Environment variables

Only these matter for the tunnel. The full reference for every variable in the
app is [usage.md → Environment variables](usage.md#environment-variables).

| Variable                                       | Used by                | Notes                                         |
| ---------------------------------------------- | ---------------------- | --------------------------------------------- |
| `AUTH_SECRET`                                  | runtime (all modes)    | required                                      |
| `CLOUDFLARE_TUNNEL_TOKEN`                      | runtime (named tunnel) | from `make tunnel-provision` or the dashboard |
| `AUTH_URL`                                     | runtime (named tunnel) | your public `https://…` URL                   |
| `CLOUDFLARE_API_TOKEN`                         | provisioning           | scoped: Tunnel:Edit + DNS:Edit                |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_ZONE_ID` | provisioning           | from the Cloudflare dashboard                 |
| `TUNNEL_HOSTNAME`                              | provisioning           | e.g. `app.example.com`                        |

Runtime vars go in `.env`; provisioning vars are best kept in
`infra/cloudflare/terraform.tfvars` (gitignored). See [`.env.example`](../.env.example).

## Quick tunnel (no account)

Instant public preview on a random `*.trycloudflare.com` URL:

```bash
make tunnel-quick
```

The URL is printed in the `cloudflared` logs. `AUTH_TRUST_HOST=true` (set in the
compose app) makes auth work on the random hostname.

The URL is thrown away when the stack stops, and you get a different one next
time. That is the trade for needing no account at all.

## Option B — Guided (dashboard)

Produces the same `CLOUDFLARE_TUNNEL_TOKEN` + DNS record by hand:

1. Zero Trust → **Networks → Tunnels → Create a tunnel** (Cloudflared). Copy the
   **token** it shows.
2. Put it in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`, and set
   `AUTH_URL=https://app.yourdomain.com`.
3. Add a **public hostname**: `app.yourdomain.com` → `http://app:3000`
   (Cloudflare creates the DNS record automatically).
4. Start it and verify:

   ```bash
   make tunnel-up
   URL=https://app.yourdomain.com make tunnel-verify
   ```

The service target in step 3 is `http://app:3000` — `app` is the Compose service
name, which `cloudflared` resolves on the internal Docker network. Using
`localhost` there points the tunnel at the `cloudflared` container itself and
gives you a 502.

## Option A — Automated (Terraform)

Provisions the tunnel, its ingress, and the DNS record, then wires the token in.

```bash
cp infra/cloudflare/terraform.tfvars.example infra/cloudflare/terraform.tfvars
# edit terraform.tfvars: api token, account id, zone id, hostname

make tunnel-provision          # terraform apply + writes CLOUDFLARE_TUNNEL_TOKEN to .env
# set AUTH_URL=https://<hostname> in .env
make tunnel-up                 # start the stack behind the tunnel
URL=https://<hostname> make tunnel-verify
```

Details and the token scopes are in [`infra/cloudflare/`](../infra/cloudflare/README.md).
Tear down with `make tunnel-destroy`.

## How the app runs behind the tunnel

Three things change once traffic arrives through Cloudflare rather than directly.

- **`AUTH_TRUST_HOST=true`** + **`AUTH_URL`** so Auth.js trusts the proxied host
  and issues secure cookies over HTTPS.
- **Client IP** is read from `CF-Connecting-IP` (set by Cloudflare, unspoofable)
  for rate limiting — see `src/lib/request-ip.ts`.
- HSTS / CSP / hardening headers are served from the origin as usual.

The first two are why a tunnel deployment with the wrong `AUTH_URL` produces a
login loop rather than an error: the app issues a cookie for one host and the
browser presents it on another.

## Operating

```bash
make tunnel-up       # start (detached)
make tunnel-down     # stop (keeps data)
# follow the daemon's logs:
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml logs -f cloudflared
```

Update `cloudflared` by re-pulling the image:
`docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml pull cloudflared && make tunnel-up`.

## Troubleshooting

Full table (all symptoms, including deploy/timer failures):
[self-hosting.md → Troubleshooting](self-hosting.md#troubleshooting). The one
specific to this doc's Terraform path: if `make tunnel-provision` succeeds but
the tunnel never connects, re-check the API token's two scopes (Prerequisites,
above) — a token missing either **Tunnel: Edit** or **DNS: Edit** fails silently
partway through provisioning.

## Notes

- Cloudflare Tunnel is free (Zero Trust free tier).
- For production, use managed Postgres and a remote Terraform state backend.
- Optional: gate the app (or staging) with **Cloudflare Access** for an
  edge SSO layer in front of the app's own auth.
- The full diagram and the clone-to-live walkthrough live in
  [self-hosting.md → How it works](self-hosting.md#how-it-works-one-diagram);
  the wider request path is in [architecture.md](architecture.md).

---

**Next:** [Backups & restore](backups.md) — the deployment is only finished once
you can get the data back.
