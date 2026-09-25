# Feature → Production

[← Back to README](../README.md)

**What this covers:** the whole path from `git checkout -b` to your change
running live on your own box, in order, with nothing skipped. Each step links to
the doc that owns the detail — this page is the map, not a third copy.

The short version: you branch off `main`, open a PR that CI checks, merge, let
CI publish the image, tag a release, and a small timer on your box notices the
new image and updates itself. Nothing ever reaches into the box; it only ever
reaches out.

> **Not GitFlow.** This repo is intentionally **trunk-based**: `main` is the only
> long-lived branch — no `develop`, `release`, or `hotfix` branches. Feature
> branches merge straight into `main`, and a release is a tag on a `main`
> commit. If "gitflow" is what you are picturing, this is that idea simplified
> to one branch.

Here is the whole path.

```text
feature/<slug> ──PR──▶ main      (CI: quality + e2e must pass)
                        │
          CI publishes the app + migrate images to GHCR
                        │
              push a v* tag  ──▶  CI re-tags the image as the semver + stable,
                        │         and creates the GitHub Release from CHANGELOG
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

Before you push, run the gate. CI runs it again on the PR, but a local failure
is quicker to fix:

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

There is no `develop` branch to target — PRs go straight into `main`. CI runs
`quality` (format, lint, typecheck, unit tests with coverage, `specs:check`) and
`e2e` (Playwright against Postgres, MinIO and Mailpit), and builds both image
architectures without pushing. Merge once it is green and a human has looked at
it. Job by job detail: [CI/CD](ci-cd.md).

## 4 — CI publishes the images

When the merge lands on `main`, CI runs the same checks again and, once both
`quality` and `e2e` are green, publishes two multi-arch images to GHCR, tagged
`sha-<short>` and `latest`:

- `ghcr.io/<owner>/<repo>` — the `runner` target, the slim production app.
- `ghcr.io/<owner>/<repo>/migrate` — the `builder` target, the migrator.

Two images, because one cannot do both jobs. The `runner` target has no source
or `tsx` in it, so it physically cannot run a migration. The deploy runs `pnpm
db:migrate` from the `builder` image as a one-shot container **before** the new
app starts, which is how a schema change — a new table, a new vector index —
reaches a running box without you touching its database by hand.

## 5 — Cut a release

Before you tag, walk this list. Every item on it is something that has been
missed on a past release — specs left mid-flight, criteria never closed out,
tags with no changelog entry:

- [ ] Every spec this release ships: `status: Shipped`, `release:` filled in
- [ ] Its acceptance criteria closed out — ticked with the evidence that backs
      them, or left open under a `> **Not verified (YYYY-MM-DD).**` note
- [ ] `pnpm specs:check` passes (regenerate with `pnpm specs:index` if it
      complains the index is stale)
- [ ] `CHANGELOG.md` has a `## [X.Y.Z]` section for this version
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

```bash
# bump "version" in package.json, update CHANGELOG.md,
# set any shipped spec's status to Shipped, close out its criteria
pnpm specs:index && pnpm specs:check
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "short title"
git push origin main --tags
```

The tag is what defines the release. It triggers `ci.yml`'s `release` job,
which waits for the image `main` already built for that commit, re-tags it with
the semver, moves the floating `stable` tag (~30s, no rebuild) and creates the
GitHub Release with this version's `CHANGELOG.md` section as its notes. See
[CI/CD → Release fast-path](ci-cd.md#release-fast-path).

## 6 — The box picks it up

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

| Concern                                 | Doc                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Branching, commits, PR process          | [CONTRIBUTING.md](../CONTRIBUTING.md)                                      |
| Scripts, testing, environment variables | [Usage & Development](usage.md)                                            |
| What CI runs, job by job                | [CI/CD](ci-cd.md)                                                          |
| Cloudflare Tunnel setup, `make setup`   | [Self-hosting](self-hosting.md)                                            |
| Mac mini boot persistence & sizing      | [Self-hosting → Mac mini](self-hosting.md#running-on-a-mac-mini-always-on) |
| Terraform / dashboard tunnel commands   | [Deployment](deployment.md)                                                |
| Nightly backups & restore               | [Backups](backups.md)                                                      |
| Troubleshooting a stuck deploy          | [Self-hosting → Troubleshooting](self-hosting.md#troubleshooting)          |

---

**Next:** [CI/CD](ci-cd.md) — what each CI job runs, and the release fast-path
behind step 5.
