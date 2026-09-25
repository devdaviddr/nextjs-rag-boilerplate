# Self-hosting

This page covers taking a fresh clone to a live app on your own domain, and
keeping that machine up to date afterwards.

Self-hosting here means one machine you control (a Mac mini under a desk, a
Linux box, a cheap VPS) running the whole stack in Docker: the Next.js app,
Postgres, MinIO for uploaded files, and the nightly backup sidecars. There is no
platform to sign up for and nothing to pay for beyond the machine itself.

The hard part is usually HTTPS on a real domain without opening a port on your
router. A **Cloudflare Tunnel** handles that. A small daemon called
`cloudflared` runs next to the app and dials out to Cloudflare, which holds the
connection open and pushes your visitors' requests back down it. You don't open
inbound ports, run a reverse proxy or renew certificates.

Setup is one command:

```bash
make setup
```

This page follows the path from clone to live to kept current. It is the guide
to `make setup` and to the deploy loop that follows it.

Two neighbouring pages cover the same ground from different angles. If you would
rather drive the tunnel by hand with the individual `make tunnel-*` targets, or
you want to understand the tunnel itself, read [deployment.md](deployment.md).
Once you are live, [backups.md](backups.md) covers data safety, and
[Feature → Production](workflow.md) is the full loop from a feature branch to a
deploy on this box. The former CI pipeline is removed, and kept as a record in
[ci-cd.md](ci-cd.md).

---

## How it works (one diagram)

Follow the arrows: everything crosses the network outwards, from your box to
Cloudflare.

```text
User ──HTTPS──▶  Cloudflare edge  ◀══ outbound tunnel ══  cloudflared ──▶ app:3000
                 (terminates TLS)                          (in Docker)
```

`cloudflared` dials out to Cloudflare and holds the connection open, and no
inbound ports are opened on your host. That is why the app container publishes
no host port in tunnel mode: it is reachable only through the tunnel. Auth
trusts the proxied host (`AUTH_TRUST_HOST` + `AUTH_URL`) and reads the real
client IP from `CF-Connecting-IP`. For more detail, see
[architecture.md](architecture.md) and [deployment.md](deployment.md).

---

## What `make setup` does

`make setup` runs [`scripts/setup.sh`](../scripts/setup.sh), a guided wizard built
on top of the existing deployment primitives. It announces each step before
running it:

```text
preflight ─▶ secrets (.env, AUTH_SECRET) ─▶ choose mode
   ├─ quick     → trycloudflare.com URL (no account)
   ├─ guided    → your domain, token pasted from the dashboard
   └─ automated → your domain, provisioned by Terraform
                          │
     seed demo admin ─────┴─▶ verify (health + HSTS + CSP) ─▶ summary (URL + login)
```

Read top to bottom, that is the whole flow. The wizard checks your tooling,
writes `.env`, puts you online by whichever route you picked, creates a demo
admin you can log in as, and then checks that the result is serving over HTTPS
with the hardening headers in place.

The wizard is idempotent, so it is safe to re-run. It never rotates an existing
`AUTH_SECRET` without asking (rotation logs everyone out and voids outstanding
password-reset/verification tokens). It writes `.env` and any Terraform vars
with `chmod 600` and never prints secrets.

---

## Prerequisites

| Requirement         | For                | Notes                                                           |
| ------------------- | ------------------ | --------------------------------------------------------------- |
| Docker + Compose    | all modes          | Compose **≥ v2.24** (the tunnel overlays use a newer merge).    |
| `openssl`           | all modes          | Generates `AUTH_SECRET`. Present on macOS/Linux by default.     |
| A Cloudflare domain | guided / automated | A domain added to your Cloudflare account (free plan is fine).  |
| `terraform`         | automated only     | Provisions the tunnel + DNS.                                    |
| A scoped API token  | automated only     | **Account → Cloudflare Tunnel: Edit** and **Zone → DNS: Edit**. |

Cloudflare Tunnel itself is free (Zero Trust free tier). On Windows, run inside
WSL.

---

## Choose your mode

The wizard asks one real question: how public do you want this to be, and how
much of it do you want to own? Pick the first row that describes you.

| Mode      | You get                                | You need                              |
| --------- | -------------------------------------- | ------------------------------------- |
| Quick     | A random `*.trycloudflare.com` URL     | Nothing (no account, no domain)       |
| Guided    | Your own domain, wired up by hand once | A Cloudflare domain + dashboard click |
| Automated | Your own domain, provisioned as code   | The above + `terraform` + API token   |

You can start with quick and re-run `make setup` later in another mode. Nothing
you do here is one-way.

### 1. Quick — instant demo, no account

Best for kicking the tyres. You get a random public
`https://<something>.trycloudflare.com` URL that lasts as long as the stack runs.

```bash
make setup            # pick "quick"
# → prints the live URL, seeds demo@example.com / Password123, verifies
```

The URL is ephemeral: every quick run gets a new one. Use a named tunnel
(below) for anything stable.

### 2. Guided — your domain, token from the dashboard

You create the tunnel by hand in Cloudflare and paste its token, and the wizard
wires up the rest.

1. In Cloudflare, go to **Zero Trust → Networks → Tunnels → Create a tunnel**
   (Cloudflared).
2. Copy the token it shows.
3. Add a public hostname: `app.yourdomain.com` → `http://app:3000`
   (Cloudflare creates the DNS record for you).
4. Run `make setup`, pick guided, and paste the token and hostname.

The wizard stores the token in `.env`, sets `AUTH_URL=https://app.yourdomain.com`
(the manual step people miss most often), brings the stack up, seeds, and
verifies.

The ingress target is `http://app:3000`, the Compose service name, which
`cloudflared` resolves inside the Docker network. It is never `localhost`, because
`localhost` inside the `cloudflared` container is the `cloudflared` container.

### 3. Automated — your domain, provisioned by Terraform

The wizard collects four Cloudflare inputs, writes
`infra/cloudflare/terraform.tfvars` (0600), and runs the Terraform module that
creates the tunnel, its ingress and the DNS record. Then it starts everything.

```bash
make setup            # pick "automated"
#   Cloudflare API token …
#   account id … / zone id … / hostname app.yourdomain.com
# → terraform apply → tunnel up → seed → verify → live URL
```

Your account ID and zone ID are on the domain's overview page in the Cloudflare
dashboard. Create the API token under **My Profile → API Tokens** with
the two scopes listed in Prerequisites.

---

## Non-interactive / scripted

For CI or repeatable installs, you can supply every prompt through the
environment:

```bash
# Quick, unattended:
SETUP_MODE=quick SETUP_YES=1 make setup

# Automated, unattended:
SETUP_MODE=automated SETUP_YES=1 \
  CF_API_TOKEN=cf_xxx CF_ACCOUNT_ID=… CF_ZONE_ID=… \
  TUNNEL_HOSTNAME=app.yourdomain.com \
  make setup
```

| Variable                  | Mode             | Purpose                            |
| ------------------------- | ---------------- | ---------------------------------- |
| `SETUP_MODE`              | all              | `quick` \| `guided` \| `automated` |
| `SETUP_YES=1`             | all              | Assume "yes" to confirmations      |
| `NO_SEED=1`               | all              | Skip seeding the demo admin        |
| `CLOUDFLARE_TUNNEL_TOKEN` | guided           | Dashboard-issued tunnel token      |
| `TUNNEL_HOSTNAME`         | guided/automated | Public hostname                    |
| `CF_API_TOKEN`            | automated        | Scoped Cloudflare API token        |
| `CF_ACCOUNT_ID`           | automated        | Cloudflare account ID              |
| `CF_ZONE_ID`              | automated        | Zone ID of the domain              |

Run `./scripts/setup.sh --help` for the same summary.

---

## Deploy with an AI agent (Claude Code / opencode)

This repo ships a `self-host` skill for both [Claude Code](https://claude.ai/code)
and [opencode](https://opencode.ai). You can tell your agent _"self-host this on
my domain"_ and it drives the flow for you: it picks the right mode, collects
your Cloudflare inputs, runs the wizard and verifies the result.

| Tool        | Skill location (in this repo)         |
| ----------- | ------------------------------------- |
| Claude Code | `.claude/skills/self-host/SKILL.md`   |
| opencode    | `.opencode/skills/self-host/SKILL.md` |

Both use the same [Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview)
format, and each tool picks its copy up automatically when you open this project,
with no install step. The skill is a thin runbook over `make setup`: it never
prints secrets, never rotates an existing `AUTH_SECRET` without asking, and
refers to this guide for the details. Invoke it explicitly with `/self-host`, or
describe the goal ("deploy this to `app.mydomain.com`") and let the agent
trigger it.

> The skill only orchestrates and bypasses nothing here. Everything it runs is a
> command you can run yourself from this page.

---

## Continuous deployment

`make setup` gets you live the first time. Continuous deployment keeps a running
box up to date as you push new code.

The tunnel decides how this works. Because the box is outbound-only (the tunnel
opens no inbound ports), nothing on the internet can push a new version to it.
Both paths below are therefore pull-based: the box reaches out for the new
image, and nothing reaches in. Tier B pulls on a timer. Tier C lets GitHub
trigger the pull, at the cost of running a GitHub runner on your network.

> The images come from `ci.yml`, which publishes `ghcr.io/<owner>/<repo>` (the
> app) and `.../migrate` (the migrator, because the app image can't run
> migrations itself) on every green merge to `main`. A `v*` tag re-tags that
> image as the semver and `stable` in ~30s. Both deploy tiers below pull those
> images. See [CI/CD](ci-cd.md) and
> [spec 0024](../specs/0024-faster-time-to-deploy.md).

### Tier B (recommended) — pull with `make deploy`

Point the box at the published image, and updating takes one command. In the
box's `.env`:

```bash
APP_IMAGE="ghcr.io/your-org/nextjs-fullstack-boilerplate"
APP_TAG="stable"        # newest RELEASE — moves when a v* tag is pushed (recommended)
# APP_TAG="latest"      # every green main merge (trunk tracking, no release gate)
# APP_TAG="0.18.0"      # pin an exact release — never moves; bump it to update
```

`APP_TAG` is the whole deployment policy: it decides what lands on the box and
when. With a floating tag (`stable`/`latest`), Settings → Build shows the tag
(`stable · <sha7>`) instead of a version number. The SHA still pins the exact
commit; pin a semver if you want the number displayed.

Then, to update:

```bash
make deploy    # docker compose pull → up -d  (prod + deploy + tunnel overlays)
```

The `deploy` overlay (`docker-compose.deploy.yml`) switches the stack from
"build locally" to "pull the published image `APP_IMAGE:APP_TAG` from GHCR".
That overlay is why `make deploy` pulls instead of rebuilding.

`make deploy` pulls both images and runs the one-shot migrate service, which
gates the app via `depends_on`, so schema changes apply before the new app
starts. It then restarts the app behind the tunnel. Nothing is built on the box.
If the package is private, run `docker login ghcr.io` once on the box with a
read-only PAT.

To automate it on macOS, install a launchd timer that runs `make deploy` on an
interval so new releases roll out unattended:

```bash
make deploy-timer                              # every 60s (default; digest-skipped)
./scripts/macos-deploy-timer.sh install 300    # or a custom interval (≥ 60s)
./scripts/macos-deploy-timer.sh status         # is it loaded?
./scripts/macos-deploy-timer.sh uninstall
```

Each tick refreshes the checkout (`git pull --ff-only`, best-effort) and copies
the operator's off-checkout `.env` from `~/.config/nextjs-fullstack-boilerplate/.env`
(override with `DEPLOY_ENV_FILE`) into the project dir. It then checks whether
the published app image actually changed, by refreshing only that image's
manifest and comparing its digest to the last-deployed one
(`~/.config/<repo>/.last-deployed-image`). An unchanged tick exits immediately,
and only a new digest triggers the full `make deploy` (pull + migrate +
recreate). That makes the short 60s interval nearly free, so the box lands a new
release within about a minute. The app's Settings → Build card shows which build
is live.

> If you already run an older timer, re-run `make deploy-timer` to regenerate
> the plist at the new default interval. The old 300s interval stays baked into
> the installed plist until you reinstall.

To roll back, re-pin: set `APP_TAG` to the previous version (or a commit `sha`
tag) and run `make deploy` again.

### Tier C (private repos only) — push-button on tag, via a self-hosted runner

> 🚫 **Do not use Tier C on a public repo.** GitHub warns against running a
> self-hosted runner on a public repository: a fork pull request can add a
> workflow that runs on `[self-hosted]` and, once approved, executes arbitrary
> code on your box and home network. The `SELF_HOSTED_DEPLOY` gate does not
> help, because a malicious fork brings its own workflow. On a public repo, use
> Tier B (`make deploy-timer`) above, which has no runner and so nothing to
> attack this way.

For a private, trusted repo where you want a release tag to deploy itself,
register your box as a GitHub self-hosted runner and enable the shipped
[`deploy.yml`](../.github/workflows/deploy.yml):

1. Add a self-hosted runner on the box (GitHub → Settings → Actions → Runners).
   The runner dials out to GitHub, so it works behind the tunnel.
2. Put the box's config at
   `~/.config/nextjs-fullstack-boilerplate/.env` (chmod 600). The runner's
   checkout is wiped every run (`git clean`), so `.env` can't live in the work
   tree. It needs at least `AUTH_SECRET`, `AUTH_URL`,
   `CLOUDFLARE_TUNNEL_TOKEN` and `APP_IMAGE` (and optionally `APP_TAG`). To use
   another path, set a `DEPLOY_ENV_FILE` env var on the runner.
3. Set the repo variable `SELF_HOSTED_DEPLOY = true` (Settings → Secrets and
   variables → Actions → Variables). Until you do, `deploy.yml` is skipped.
4. Push a `v*` tag. The runner copies that env file into the checkout and runs
   `make deploy` on the box.

> ⚠️ Even on a private repo, a self-hosted runner executes workflow code on your
> network, so prefer an ephemeral, low-privilege runner. Tier B (pull) avoids
> this entirely and is the recommended default.

### Note on Watchtower

[Watchtower](https://containrrr.dev/watchtower/) can auto-pull the updated `app`
container, but it won't run the one-shot `migrate`. It silently skips schema
changes, so it is only safe for migration-free releases. Prefer `make deploy`,
which always migrates first. If you use Watchtower anyway, run migrations
yourself on any release that changes the schema.

---

## Day-2 operations

```bash
# Follow logs (app + cloudflared):
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml logs -f

make tunnel-down     # stop the tunnel stack (keeps data)
make tunnel-up       # start it again

# Update to a newer cloudflared:
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml pull cloudflared
make tunnel-up
```

The production stack runs nightly Postgres + MinIO backup sidecars, and the
restore runbook is in [backups.md](backups.md). To re-verify at any time, run
`URL=https://app.yourdomain.com make tunnel-verify`.

To tear down, `docker compose -f docker-compose.prod.yml down -v` removes
containers and data. In automated mode, `make tunnel-destroy` also removes the
Cloudflare tunnel + DNS record.

---

## Running on a Mac mini (always-on)

A Mac mini works well as a single-box host for this stack, but macOS needs
hardening in 4 areas to survive reboots unattended: boot persistence, the
container runtime, sizing, and backups.

Boot persistence takes one command:

```bash
make autostart          # installs a login LaunchAgent (see scripts/macos-autostart.sh)
```

The agent waits for the Docker engine at login, then runs `make tunnel-up`. For
pull-based updates, pass a target instead:
`./scripts/macos-autostart.sh install deploy`. Check it with
`./scripts/macos-autostart.sh status`; logs land in `~/Library/Logs/`.
Containers already use `restart: unless-stopped`, so the agent only has to
cover the reboot case. For it to work unattended you also need:

- Auto-login (System Settings → Users & Groups → Automatically log in), because
  LaunchAgents run at login and Docker Desktop needs a GUI session.
- Your container runtime set to start at login (a Docker Desktop / OrbStack
  setting).
- Sleep disabled: `sudo pmset -a sleep 0 disablesleep 1 womp 1`

For unattended updates on top of boot persistence, add the Tier B pull timer
(`make deploy-timer`, above). The box then keeps itself current on each release
with no self-hosted runner.

For the container runtime, Docker Desktop works out of the box (Apple Silicon
native). [OrbStack](https://orbstack.dev) or Colima are lighter and friendlier
for a headless server. The wizard and Makefile work the same with any of them,
since they all provide `docker` + `compose`.

Give the Docker VM at least 4 GB of memory (8 GB is comfortable) for Postgres +
MinIO + the app + backup sidecars, under Docker Desktop → Settings → Resources.
Watch `docker stats` under load.

The nightly dumps land in `./backups` on the same disk as the data, and the
Docker volumes (`pgdata`, `miniodata`) live inside Docker's Linux VM, where
**Time Machine does not reach them**. Time Machine does cover the dumps in
`./backups`, but for real disk-failure resilience, enable the offsite copy
(Cloudflare R2/S3) or point `./backups` at an external drive. See
[backups.md](backups.md#optional-offsite-copy-disk-failure-resilience).

---

## Troubleshooting

Find the symptom and apply the fix. These are the failures people actually hit.

| Symptom                                                       | Fix                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Preflight: Compose too old**                                | Upgrade Docker Desktop / the compose plugin to ≥ v2.24.                                                                                                                                                                                                                                                                                                                               |
| **Port 3000 already in use**                                  | Only affects the plain `docker-compose.prod.yml`; tunnel modes publish no host port. Stop the other process (e.g. a stray `pnpm dev`).                                                                                                                                                                                                                                                |
| **502 / Bad gateway**                                         | App not ready yet, or the ingress target is wrong. It must be `http://app:3000` (the Compose service name), never `localhost`.                                                                                                                                                                                                                                                        |
| **Login loop / cookies drop**                                 | `AUTH_URL` must be the exact public `https://…` URL and `AUTH_TRUST_HOST=true` (both set for you by the wizard).                                                                                                                                                                                                                                                                      |
| **Tunnel won't connect**                                      | Check the token (`make tunnel-token`) and `cloudflared` logs; a token is bound to one tunnel.                                                                                                                                                                                                                                                                                         |
| **503 everywhere + "No ingress rules" in `cloudflared` logs** | The tunnel is _locally-managed_ (created with `cloudflared tunnel create`), so a token-run daemon gets no remote config. Create tunnels in the **dashboard** or via **Terraform** (both remotely-managed), or push a remote config: the token embedded in `~/.cloudflared/cert.pem` (`ARGO TUNNEL TOKEN` block → base64 JSON `.apiToken`) can `PUT …/cfd_tunnel/<id>/configurations`. |
| **Quick URL changed**                                         | It's ephemeral by design. Use guided/automated for a stable domain.                                                                                                                                                                                                                                                                                                                   |
| **Rate limiting sees wrong IP**                               | Traffic must arrive via Cloudflare so `CF-Connecting-IP` is present; direct origin hits won't have it.                                                                                                                                                                                                                                                                                |
| **`make deploy` / timer tick fails: `.env` not found**        | The box's `.env` needs at least `AUTH_SECRET`, `AUTH_URL`, `CLOUDFLARE_TUNNEL_TOKEN`, and `APP_IMAGE` (+ optionally `APP_TAG`). `make deploy` reads the project-dir `.env`; `make deploy-timer` copies it in each tick from `~/.config/nextjs-fullstack-boilerplate/.env`; override the source path with `DEPLOY_ENV_FILE`.                                                           |

---

Next, [Deployment: Cloudflare Tunnel](deployment.md) covers the tunnel itself
and the by-hand `make tunnel-*` route, and [Backups & restore](backups.md) makes
sure the box's data survives a bad day.
