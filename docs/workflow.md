# Feature → Production

**What this covers:** the whole path from `git checkout -b` to your change
running live on your own box, in order, with nothing skipped. Each step links to
the doc that owns the detail, so this page is a map and does not repeat it.

In short: you branch off `main`, open a PR that CI checks, merge, let CI publish
the image, and tag a release. A small timer on your box then notices the new
image and updates itself. Nothing ever reaches into the box; it only ever
reaches out.

> This repo is intentionally trunk-based and does not use GitFlow. `main` is the
> only long-lived branch, with no `develop`, `release`, or `hotfix` branches.
> Feature branches merge straight into `main`, and a release is a tag on a
> `main` commit. If you are picturing "gitflow", this is that idea simplified to
> one branch.

Here is the whole path.

```text
<type>/<issue#>-<slug> ──PR──▶ main   (CI + PR checks must pass)
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

Every change starts from an issue on the project board. That is either a
`[Feature]` under its `[Capability]`, or a `[Bug]`, `[Change]`, `[Chore]` or
`[Spike]`. File one if it does not exist, and move it to In Progress. Then
create a branch that names the issue:

```bash
git checkout main && git pull
git checkout -b <type>/<issue#>-<slug>     # e.g. feat/16-reranking
```

For a non-trivial change, write a spec first: copy
[`specs/TEMPLATE.md`](../specs/TEMPLATE.md) and open it as `Proposed`. See
[specs/README.md](../specs/README.md).

Commit with [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `docs:`, `chore:` …). A commitlint `commit-msg` hook enforces
this, and a `pre-commit` hook runs lint-staged over your staged files.

Full detail is in [CONTRIBUTING.md → Workflow](../CONTRIBUTING.md#workflow).

## 2 — Develop and verify locally

```bash
pnpm dev
```

Before you push, run the gate. CI runs it again on the PR, but a local failure
is quicker to fix:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

To run the browser suite as well, start the dependencies first: Postgres,
MinIO, and Mailpit for the email round-trips.

```bash
pnpm docker:db && pnpm docker:minio && pnpm docker:mail && \
  pnpm db:migrate && pnpm db:seed && pnpm build && pnpm test:e2e
```

See [Usage & Development](usage.md) for what each script does and what the
suites cover.

## 3 — Open a PR into `main`

Push your branch and stop there. Pull requests into `main` are opened when the
owner ships a release (`/ship`): it opens one PR per finished branch, merges
each once CI is green, then cuts the release. GitHub cannot enforce this, so it
is a working rule.

PRs go straight into `main`, since there is no `develop` branch, and `main` only
changes through them. Fill in the template with a Conventional Commit title,
`Closes #N` for the issue, the CHANGELOG entry and the docs you touched. The PR
checks job fails without the issue link, on a commit or title that is not
Conventional, or on a `feat`/`fix`/`perf`/`revert`/breaking PR with no
`CHANGELOG.md` change (label it `no-changelog` if users cannot notice it). CI runs
`quality` (format, lint, typecheck, unit tests with coverage, `specs:check`) and
`e2e` (Playwright against Postgres, MinIO and Mailpit), and builds both image
architectures without pushing. Merge once it is green and a human has looked at
it. [CI/CD](ci-cd.md) has the job-by-job detail.

## 4 — CI publishes the images

When the merge lands on `main`, CI runs the same checks again. Once both
`quality` and `e2e` are green, it publishes two multi-arch images to GHCR,
tagged `sha-<short>` and `latest`:

- `ghcr.io/<owner>/<repo>` is the `runner` target, the slim production app.
- `ghcr.io/<owner>/<repo>/migrate` is the `builder` target, the migrator.

There are two images because one cannot do both jobs. The `runner` target has
no source or `tsx` in it, so it physically cannot run a migration. The deploy runs `pnpm
db:migrate` from the `builder` image as a one-shot container **before** the new
app starts. That is how a schema change, such as a new table or a new vector
index, reaches a running box without you touching its database by hand.

## 5 — Cut a release

In Claude Code, run `/ship`, which walks through this section step by step. To
do it by hand, follow the steps below.

First, choose the version. `pnpm release:next` reads the Conventional Commits
since the last tag and suggests one. Versioning is SemVer. While the version is
`0.x`, a breaking change or a `feat` bumps the minor and anything else bumps the
patch; from `1.0.0`, breaking → major, `feat` → minor, else patch.

Next, open the release PR. `main` is protected, so the release commit goes
through a PR like any other change:

- [ ] `package.json` `version` set to `X.Y.Z`
- [ ] `CHANGELOG.md`: `[Unreleased]` renamed to `## [X.Y.Z] - YYYY-MM-DD`, with
      a new empty `[Unreleased]` above it, and an entry for every `feat`/`fix`
- [ ] Every spec this release ships: `status: Shipped`, `release: vX.Y.Z`, its
      acceptance criteria ticked with the evidence that backs them, or left
      open under a `> **Not verified (YYYY-MM-DD).**` note
- [ ] `pnpm specs:index`, and docs that name the old version updated
- [ ] `pnpm release:check` and
      `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass

```bash
git checkout -b release/vX.Y.Z
# edits above, then:
pnpm release:check
git commit -am "chore(release): vX.Y.Z"
gh pr create --title "chore(release): vX.Y.Z"
```

Every item on that list has been missed on a past release. Specs were left
mid-flight, criteria were never closed out, and tags went out with no changelog
entry. `release:check` fails on each of them.

Then tag the merge commit once `main`'s CI is green:

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "short title"
git push origin vX.Y.Z
```

The tag defines the release. It triggers `ci.yml`'s `release` job, which runs
`release:check` against the tag, waits for the image `main` already built for
that commit, and re-tags it with the semver. The job then moves the floating
`stable` tag (~30s, no rebuild) and creates the GitHub Release with this
version's `CHANGELOG.md` section as its notes. See
[CI/CD → Release fast-path](ci-cd.md#release-fast-path). Close the release's
milestone when it is done.

## 6 — The box picks it up

A Mac mini (or any always-on host) running the recommended Tier B pull timer
notices the new image digest on its next poll (≤60s) and runs `make deploy`
itself. That pulls the new image, runs the one-shot migration, and restarts the
app behind the tunnel. Nothing is pushed to the box; it only ever pulls.

```bash
make deploy-timer            # one-time: install the poll timer (default 60s)
```

Confirm that the box's `.env` has `APP_TAG="stable"`. That is the default
recommendation, and that one line is the whole deployment policy. See
[Self-hosting → Tier B](self-hosting.md#tier-b-recommended--pull-with-make-deploy).

To see which build actually landed, open the Settings → Build card in the
running app, or check from the CLI:

```bash
URL=https://app.yourdomain.com make tunnel-verify
```

## 7 — First time on a fresh box

If the box has never run this app, do not assemble the pieces by hand.
`make setup` walks through the whole first bring-up in one guided pass. It
generates secrets, lets you choose a tunnel mode (quick, guided, or automated),
seeds the first admin user and verifies the live URL:

```bash
make setup
```

[Self-hosting](self-hosting.md) has the full walkthrough.

For an always-on Mac mini, surviving a reboot is a separate, one-time concern
from the deploy flow above:

```bash
make autostart                # login LaunchAgent: waits for Docker, then `make tunnel-up`
```

Outside this repo, you also need to enable auto-login, set the container
runtime to start at login, and disable sleep (`sudo pmset -a sleep 0 disablesleep 1
womp 1`). Details are in
[Self-hosting → Running on a Mac mini](self-hosting.md#running-on-a-mac-mini-always-on).

## 8 — Rollback

To roll back, re-pin the tag on the box. You do not revert code there:

```bash
# on the box, in .env:
APP_TAG="0.18.0"      # the previous known-good release
make deploy
```

Pin an exact version instead of re-pushing an old floating tag. A pinned semver
never moves, so you know precisely what is running.

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

**Next:** [CI/CD](ci-cd.md) covers what each CI job runs and the release
fast-path behind step 5.
