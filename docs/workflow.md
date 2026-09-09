# Feature → Production

[← Back to README](../README.md)

**What this covers:** the whole path from `git checkout -b` to your change
running live on your own box, in order, with nothing skipped. Each step links to
the doc that owns the detail — this page is the map, not a third copy.

The short version: you branch off `main`, run the quality gate yourself (there
is no CI in this fork), merge, build and push a container image by hand, tag a
release, and a small timer on your box notices the new image and updates itself.
Nothing ever reaches into the box; it only ever reaches out.

> **Not GitFlow.** This repo is intentionally **trunk-based**: `main` is the only
> long-lived branch — no `develop`, `release`, or `hotfix` branches. Feature
> branches merge straight into `main`, and a release is a tag on a `main`
> commit. If "gitflow" is what you are picturing, this is that idea simplified
> to one branch.

Here is the whole path. The starred step is the one that used to be automatic
and now is yours to run.

```text
feature/<slug> ──PR──▶ main
                        │
         ★ you build & push the images   (CI used to do this)
                        │
              push a v* tag  ──▶  release cut (tag + CHANGELOG)
                        │
      Mac mini (Tier B timer, <=60s poll) pulls, migrates, restarts
                        │
                live behind the Cloudflare Tunnel
```

Everything from the tag downwards is pull-based: the box polls for a new image
and updates itself. That is what lets it sit behind a tunnel with no open
inbound ports.

---

## 1 — Start a feature

```bash
git checkout main && git pull
git checkout -b feature/<slug>
```

For a non-trivial change, write a spec first: copy
[`specs/TEMPLATE.md`](../specs/TEMPLATE.md) and open it as `Proposed`. See
[specs/README.md](../specs/README.md).

Commit with [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `docs:`, `chore:` …). A commitlint `commit-msg` hook enforces
this, and a `pre-commit` hook runs lint-staged over your staged files.

Full detail: [CONTRIBUTING.md → Workflow](../CONTRIBUTING.md#workflow).

## 2 — Develop and verify locally

```bash
pnpm dev
```

Before you push, run the gate. **Nothing runs it for you** — this fork has no
CI, so this command is the entire quality bar:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

For the browser suite as well, start the dependencies first — Postgres, MinIO,
and Mailpit for the email round-trips:

```bash
pnpm docker:db && pnpm docker:minio && pnpm docker:mail && \
  pnpm db:migrate && pnpm db:seed && pnpm build && pnpm test:e2e
```

See [Usage & Development](usage.md) for what each script does and what the
suites cover.

## 3 — Open a PR into `main`

There is no `develop` branch to target — PRs go straight into `main`. There are
also no status checks, so the PR is a review step, not a gate. Merge once you
have run step 2 and a human has looked at it.

What the removed pipeline used to run on every PR, job by job, is kept as a
record in [CI/CD](ci-cd.md).

## 4 — Build and push the images

Nothing is built or published when you merge. The `docker` / `docker-merge` jobs
that pushed `ghcr.io/<owner>/<repo>` and `.../migrate` went with `ci.yml`, so
**there is currently no image for a deploy to pull.** Build both yourself:

```bash
docker build --target runner  -t ghcr.io/<owner>/<repo>:stable .
docker build --target builder -t ghcr.io/<owner>/<repo>/migrate:stable .
docker push ghcr.io/<owner>/<repo>:stable
docker push ghcr.io/<owner>/<repo>/migrate:stable
```

Two images, because one cannot do both jobs. The `runner` target is the slim
production app and has no source or `tsx` in it, so it physically cannot run a
migration. The `builder` target is the migrator: the deploy runs `pnpm
db:migrate` from it as a one-shot container **before** the new app starts, which
is how a schema change — a new table, a new vector index — reaches a running box
without you touching its database by hand.

Tag those images with whatever your box tracks. `stable` above matches the
recommended default in step 6.

## 5 — Cut a release

```bash
# bump "version" in package.json, update CHANGELOG.md,
# set any shipped spec's status to Shipped
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "short title"
git push origin main --tags
```

The tag is what defines the release. It no longer triggers anything: the
`release` job that re-tagged the image and moved the floating `stable` tag was
part of `ci.yml`. `deploy.yml` still listens for `v*` tags, but it is gated
behind the repository variable `SELF_HOSTED_DEPLOY` (currently `false`) — and
even switched on it would look for an image nobody built. Restore an
image-publishing job before turning it on. See
[CI/CD → What is still in `.github/workflows/`](ci-cd.md#what-is-still-in-githubworkflows).

## 6 — The box picks it up

> This step needs an image to exist under the tag your box tracks — so do step 4
> before you expect anything to happen.

A Mac mini (or any always-on host) running the recommended **Tier B** pull timer
notices the new image digest on its next poll (≤60s) and runs `make deploy`
itself: pull the new image, run the one-shot migration, restart the app behind
the tunnel. Nothing is pushed to the box; it only ever pulls.

```bash
make deploy-timer            # one-time: install the poll timer (default 60s)
```

Confirm the box's `.env` has `APP_TAG="stable"` — the default recommendation,
and the whole deployment policy in one line. See
[Self-hosting → Tier B](self-hosting.md#tier-b-recommended--pull-with-make-deploy).

To see which build actually landed, open the running app's **Settings → Build**
card, or check from the CLI:

```bash
URL=https://app.yourdomain.com make tunnel-verify
```

## 7 — First time on a fresh box

If the box has never run this app, do not assemble the pieces by hand.
`make setup` walks the whole first bring-up in one guided pass — generate
secrets, choose a tunnel mode (quick, guided, or automated), seed the first
admin user, verify the live URL:

```bash
make setup
```

Full walkthrough: [Self-hosting](self-hosting.md).

For an **always-on Mac mini** specifically, surviving a reboot is a separate,
one-time concern from the deploy flow above:

```bash
make autostart                # login LaunchAgent: waits for Docker, then `make tunnel-up`
```

Plus, outside this repo: enable **auto-login**, set the container runtime to
**start at login**, and disable sleep (`sudo pmset -a sleep 0 disablesleep 1
womp 1`). Detail:
[Self-hosting → Running on a Mac mini](self-hosting.md#running-on-a-mac-mini-always-on).

## 8 — Rollback

A rollback is re-pinning the tag, not reverting code on the box:

```bash
# on the box, in .env:
APP_TAG="0.18.0"      # the previous known-good release
make deploy
```

Pin an exact version rather than re-pushing an old floating tag — a pinned
semver never moves, so you know precisely what is running.

---

## Where things live, at a glance

| Concern                                         | Doc                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| Branching, commits, PR process                  | [CONTRIBUTING.md](../CONTRIBUTING.md)                                      |
| Scripts, testing, environment variables         | [Usage & Development](usage.md)                                            |
| What CI used to run (removed, kept as a record) | [CI/CD](ci-cd.md)                                                          |
| Cloudflare Tunnel setup, `make setup`           | [Self-hosting](self-hosting.md)                                            |
| Mac mini boot persistence & sizing              | [Self-hosting → Mac mini](self-hosting.md#running-on-a-mac-mini-always-on) |
| Terraform / dashboard tunnel commands           | [Deployment](deployment.md)                                                |
| Nightly backups & restore                       | [Backups](backups.md)                                                      |
| Troubleshooting a stuck deploy                  | [Self-hosting → Troubleshooting](self-hosting.md#troubleshooting)          |

---

**Next:** [CI/CD](ci-cd.md) — why the automated pipeline is gone, and the full
record of what it did, including the release fast-path this playbook's step 5
used to rely on.
