---
name: self-host
description: Deploy THIS Next.js boilerplate to production behind a Cloudflare Tunnel — clone-to-live with the `make setup` wizard (quick / guided / automated on-ramps), seed an admin, and verify. Use when the user wants to self-host, deploy to their own domain, ship it live, or set it up on a Mac mini / home server / VPS.
---

# Self-host this app (Cloudflare Tunnel)

Drive [`scripts/setup.sh`](../../../scripts/setup.sh) (via `make setup`) to take a
fresh clone to a live app on the user's own domain over HTTPS — no open ports, no
reverse proxy, no certificates. This skill is **orchestration only**: the wizard
does the work; your job is to pick the right mode, collect the inputs, run it,
and verify. Full reference: [`docs/self-hosting.md`](../../../docs/self-hosting.md).

## When to use

Triggers: "deploy this", "self-host", "put it on my domain", "run it on my Mac
mini / home server / VPS", "ship it live".

## 1 — Pick a mode

Infer or ask which on-ramp fits:

| Mode          | For                       | Needs                                                            |
| ------------- | ------------------------- | ---------------------------------------------------------------- |
| **quick**     | throwaway demo            | nothing — ephemeral `*.trycloudflare.com` URL                    |
| **guided**    | real domain, no Terraform | a tunnel **token** + hostname from the Cloudflare dashboard      |
| **automated** | real domain, hands-off    | Terraform + a scoped API token + account id + zone id + hostname |

For a **permanent box**, recommend **automated** if `terraform` is installed,
otherwise **guided**. Use **quick** only to demo.

## 2 — Preflight

- Docker is running and `docker compose version --short` reports **≥ 2.24**.
- Automated mode only: `terraform` is on `PATH`.
- The wizard also checks these and fails with a specific message; don't duplicate
  its work, just make sure Docker is up first.

## 3 — Run the wizard

Prefer the **non-interactive** form once you have the values (so it runs
unattended); fall back to `make setup` to prompt interactively.

```bash
# quick
SETUP_MODE=quick SETUP_YES=1 make setup

# guided
SETUP_MODE=guided SETUP_YES=1 \
  CLOUDFLARE_TUNNEL_TOKEN=… TUNNEL_HOSTNAME=app.example.com make setup

# automated
SETUP_MODE=automated SETUP_YES=1 \
  CF_API_TOKEN=… CF_ACCOUNT_ID=… CF_ZONE_ID=… TUNNEL_HOSTNAME=app.example.com make setup
```

The wizard: generates `AUTH_SECRET` → writes `.env` (and sets `AUTH_URL`) →
provisions/starts the stack → seeds `demo@example.com` with a random password (printed once) → verifies
`/api/health` + HSTS + CSP → prints the live URL.

## 4 — Gather Cloudflare inputs (guided / automated)

- **Account ID + Zone ID** — the domain's overview page in the Cloudflare dashboard.
- **API token** (automated) — My Profile → API Tokens; scopes:
  **Account → Cloudflare Tunnel: Edit** and **Zone → DNS: Edit**.
- **Tunnel token** (guided) — Zero Trust → Networks → Tunnels → Create a tunnel
  (Cloudflared); then add a public hostname routed to **`http://app:3000`**.

## 5 — After it's live

- Report the live URL and the seeded admin login.
- Tell the user to **change the demo password / create a real admin and delete the
  demo user** before sharing the URL.
- Re-verify anytime: `URL=https://app.example.com make tunnel-verify`.

## Secrets — hard rules

- **Never** print `AUTH_SECRET`, the Cloudflare API token, or the tunnel token to
  the chat or logs.
- **Never** rotate an existing `AUTH_SECRET` without explicit confirmation — it
  logs everyone out and voids outstanding password-reset / verification tokens.
- `.env` and `infra/cloudflare/terraform.tfvars` stay `0600` and gitignored (the
  wizard enforces this) — never commit them.

## Always-on (Mac mini / home server)

The wizard makes it _live_, not _boot-persistent_. Offer to help with:

- **Never sleep:** `sudo pmset -a sleep 0 disablesleep 1 womp 1`.
- **Start the container runtime on boot:** OrbStack/Colima (headless-friendly), or
  Docker Desktop + auto-login. Containers already use `restart: unless-stopped`.
- **Auto-start the stack:** `make autostart` installs a login LaunchAgent
  (`scripts/macos-autostart.sh` — waits for Docker, then `make tunnel-up`;
  `install deploy` for pull-based updates instead).

## Operate / teardown

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml logs -f
make tunnel-down                                   # stop (keeps data)
docker compose -f docker-compose.prod.yml down -v  # teardown + wipe data
make tunnel-destroy                                # automated: remove CF tunnel + DNS
```

## Troubleshooting (see `docs/self-hosting.md` for the full table)

- **502 / Bad gateway** — ingress target must be `http://app:3000` (the Compose
  service name), never `localhost`.
- **Login loop / cookies drop** — `AUTH_URL` must be the exact public `https://…`
  URL and `AUTH_TRUST_HOST=true` (the wizard sets both).
- **Tunnel won't connect** — check the token (`make tunnel-token`) and the
  `cloudflared` logs; a token is bound to one tunnel.
