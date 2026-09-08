# Feature → Production

[← Back to README](../README.md)

One connected playbook for taking a change from a feature branch to a live
update on your box — the git workflow ([CONTRIBUTING.md](../CONTRIBUTING.md)),
what the removed CI/CD used to do ([CI/CD](ci-cd.md)), and the deploy target this repo is
built for, a **Mac mini (or any always-on box) behind a Cloudflare Tunnel**
([Self-hosting](self-hosting.md)) — stitched into one ordered walkthrough. Each
step links back to the doc that owns the detail; this page is the map, not a
third copy.

> **Not GitFlow.** This repo is intentionally **trunk-based**: `main` is the
> only long-lived branch — no `develop`, `release`, or `hotfix` branches.
> Feature branches merge straight into `main`, and a release is just a tag on
> a green `main` commit. If "gitflow" is what you're picturing, this is that
> idea simplified to one branch.

```text
feature/<slug> ──PR──▶ main ──CI green──▶ image published (sha + latest)
                                              │
                                    push a v* tag (after CI is green)
                                              │
                                 release job re-tags: semver + stable (~30s)
                                              │
                         Mac mini (Tier B timer, ≤60s poll) pulls, migrates, restarts
                                              │
                                      live behind the tunnel
```

---

## 1 — Start a feature

```bash
git checkout main && git pull
git checkout -b feature/<slug>
```

- For a non-trivial change, write a spec first — copy
  [`specs/TEMPLATE.md`](../specs/TEMPLATE.md), open it as `Proposed`. See
  [specs/README.md](../specs/README.md).
- Commit with [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `docs:`, `chore:`…) — enforced by a commitlint hook.

Full detail: [CONTRIBUTING.md → Workflow](../CONTRIBUTING.md#workflow).

## 2 — Develop and verify locally

```bash
pnpm dev
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # before pushing
```

Add `pnpm test:e2e` for the full suite (needs `pnpm docker:db`,
`pnpm docker:minio`, and — for the email round-trips — `pnpm docker:mail`).
See [Usage & Development](usage.md).

## 3 — Open a PR into `main`

There is no CI in this fork. The gate is the pre-commit hook plus this, run
locally before every push:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Merge once that is green. There's no `develop` branch to target — PRs go
straight into `main`. What the pipeline used to run, job by job, is kept as a
record in [CI/CD](ci-cd.md) and is the starting point if it is ever restored.

## 4 — `main` is merged

Nothing is built or published on merge. The `docker`/`docker-merge` jobs that
pushed `ghcr.io/<owner>/<repo>` and `.../migrate` went with `ci.yml`, so
**there is currently no image for a deploy to pull**. Build one yourself when
you need it:

```bash
docker build -t ghcr.io/<owner>/<repo>:sha-$(git rev-parse --short HEAD) .
docker push ghcr.io/<owner>/<repo>:sha-$(git rev-parse --short HEAD)
```

## 5 — Cut a release

```bash
# bump "version" in package.json, update CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "short title"
git push origin main --tags
```

The tag is what defines the release, and it is what moves the shipped specs to
`Shipped`. It no longer triggers anything: the `release` job that re-tagged the
image and moved the floating `stable` tag was part of `ci.yml`. `deploy.yml`
still listens for `v*` tags but is gated behind the repo variable
`SELF_HOSTED_DEPLOY` (currently `false`), and even enabled it would look for an
image nobody built. Restore an image-publishing job before turning it on.

## 6 — The box picks it up

> Depends on an image existing under the `stable` tag — see step 4. Until an
> image-publishing job is restored, tag it yourself after `docker push`.

A Mac mini (or any host) running the recommended **Tier B** pull timer
notices the moved `stable` tag on its next poll (≤60s) and runs `make deploy`
itself — pull the new image, run the one-shot migration, restart the app
behind the tunnel. No push from CI reaches the box; it only ever pulls.

```bash
make deploy-timer            # one-time: install the poll timer (default 60s)
```

Confirm the box's `.env` has `APP_TAG="stable"` (the default recommendation —
see [Self-hosting → Tier B](self-hosting.md#tier-b-recommended--pull-with-make-deploy)).
Watch which build actually landed in the running app's **Settings → Build**
card, or re-verify from the CLI:

```bash
URL=https://app.yourdomain.com make tunnel-verify
```

## 7 — First time on a fresh box

If the box has never run this app, `make setup` does steps 6–7 in one guided
pass — secrets, tunnel mode (quick/guided/automated), seed, verify. Full
walkthrough: [Self-hosting](self-hosting.md).

For an **always-on Mac mini** specifically, boot persistence is a separate,
one-time concern from the deploy flow above:

```bash
make autostart                # login LaunchAgent: waits for Docker, then `make tunnel-up`
```

Plus, outside this repo: enable **auto-login**, set the container runtime to
**start at login**, and disable sleep (`sudo pmset -a sleep 0 disablesleep 1
womp 1`). Detail: [Self-hosting → Running on a Mac mini](self-hosting.md#running-on-a-mac-mini-always-on).

## 8 — Rollback

A rollback is just re-pinning the tag, not reverting code on the box:

```bash
# on the box, in .env:
APP_TAG="0.18.0"      # the previous known-good release
make deploy
```

---

## Where things live, at a glance

| Concern                                         | Doc                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| Branching, commits, PR process                  | [CONTRIBUTING.md](../CONTRIBUTING.md)                                      |
| What CI used to run (removed, kept as a record) | [CI/CD](ci-cd.md)                                                          |
| Cloudflare Tunnel setup, `make setup`           | [Self-hosting](self-hosting.md)                                            |
| Mac mini boot persistence & sizing              | [Self-hosting → Mac mini](self-hosting.md#running-on-a-mac-mini-always-on) |
| Terraform / dashboard tunnel commands           | [Deployment](deployment.md)                                                |
| Nightly backups & restore                       | [Backups](backups.md)                                                      |
| Troubleshooting a stuck deploy                  | [Self-hosting → Troubleshooting](self-hosting.md#troubleshooting)          |
