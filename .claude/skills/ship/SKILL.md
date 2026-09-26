---
name: ship
description: Ship THIS repo — open and merge the PRs for finished branches (the only place PRs into main are opened), then cut a release — choose the SemVer bump from the Conventional Commits since the last tag, roll CHANGELOG [Unreleased] into the new version, flip finished specs to Shipped, bump package.json, update docs, open and merge the release PR, tag it, and confirm CI published the image and the GitHub Release. Use when the user says ship, release, cut a release, tag a version, bump the version, or publish vX.Y.Z.
---

# Ship a release

Shipping is the **only** time pull requests into `main` are opened, and only
when the owner starts it. Between ships, work is committed to
`<type>/<issue#>-<slug>` branches and pushed, and waits here (see `CLAUDE.md` →
Work tracking). So a ship first lands the finished branches, then cuts the
release.

A release is a `vX.Y.Z` tag on a `main` commit. `main` is protected, so it is
made in two parts: a **release PR** that makes the repo describe the new version,
then a **tag** on the merge commit, which CI turns into images and a GitHub
Release. The rules are in [`CLAUDE.md` → Releasing](../../../CLAUDE.md) and
[`docs/workflow.md` § 5](../../../docs/workflow.md); this skill is the ordered
walk through them. Stop and report at the first step that fails — never skip a
check to get a release out.

## 0 — Preconditions

```bash
gh api user --jq .login                         # the repo owner's account
git switch main && git pull --ff-only && git status --short   # clean
git fetch --tags
gh run list --branch main --workflow CI -L 1    # latest main run: completed success
```

If `main`'s latest CI run is not green, stop and find out why. CI only tests in
full on the release PR (feature PRs run lint, typecheck and unit; feature merges
run nothing), so the release PR is where E2E and the image build first see this
ship's work together.

Check the open work planned for this release:

```bash
gh issue list --milestone vX.Y.Z --state open
```

Open issues in the milestone mean it is not ready. Tell the user which, and ask
whether to move them to the next milestone or wait. (Issues whose branch is
ready are closed by landing it in the next step.)

## 0.5 — Land the finished branches

List the pushed branches that are ahead of `main`:

```bash
git fetch --prune origin
for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin \
    | grep -vE '^origin/(main|HEAD)$'); do
  ahead=$(git rev-list --count origin/main.."$b")
  [ "$ahead" -gt 0 ] && echo "$b  +$ahead  $(git log -1 --format=%s "$b")"
done
```

Show the list with each branch's issue, and **ask the user which to include**.
For each chosen branch, in dependency order:

1. `gh pr create --base main --head <branch>`: Conventional Commit title,
   `Closes #N`, template filled in. The PR checks enforce the issue link and
   the CHANGELOG entry.
2. Wait for CI. Merge only when every required check has **passed**:
   `gh pr checks <n>` must list them all, none pending or failed. No checks yet
   means keep waiting, not "fine".
3. If a later branch conflicts after an earlier merge, rebase it on `main`, run
   the local gate, push, and let its CI run again.

Then confirm `main`'s CI is green on the last merge before choosing the
version.

## 1 — Choose the version

```bash
pnpm release:next
```

It prints the last tag, the suggested version and the commits that drive the
bump. Rules (SemVer; pre-1.0 while the major is 0): breaking or `feat` → minor,
anything else → patch; from 1.0, breaking → major, `feat` → minor, else patch.
Show the suggestion and **confirm the version with the user** before writing
anything. If a `feat` commit was really internal, the user may choose a patch.

## 2 — Release branch and edits

```bash
git switch -c release/vX.Y.Z
```

1. **`package.json`** — set `"version": "X.Y.Z"`.
2. **`CHANGELOG.md`** — rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`
   (today), and add a fresh empty `## [Unreleased]` above it. Read the moved
   section against `git log vPREV..HEAD --oneline`: every `feat`/`fix`/`perf`
   should have an entry. Renovate's `fix(deps)`/`chore(deps)` PRs carry
   `no-changelog`, so add one `### Changed` line summarising the notable
   dependency updates since `vPREV` instead. Add missing ones in the existing style (a bold lead
   sentence, then what changed and why it matters to a user of the template).
3. **Specs** — for every spec with all acceptance criteria ticked and status
   `Proposed`, set `status: Shipped`, `release: vX.Y.Z`, `updated:` today.
   Leave specs with open criteria alone unless each open box has a
   `> **Not verified (YYYY-MM-DD).**` note. Then `pnpm specs:index`.
4. **Docs** — find stale version strings and fix them:
   `git grep -n "PREV_VERSION" -- docs README.md CLAUDE.md` (e.g. the
   "Version" line in `docs/summary.md`). For each `feat` since the last tag,
   confirm the page that owns it (see `CLAUDE.md` → "Docs move with the code")
   describes it; if not, update it now or stop and tell the user.

## 3 — Check

```bash
pnpm release:check          # package.json, CHANGELOG, [Unreleased], specs, version order
pnpm specs:check
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm format:check
```

All must pass. `release:check` is also run by CI on the tag, so a failure here
would only fail there later.

## 4 — Release PR

```bash
git add -A
git commit -m "chore(release): vX.Y.Z"
git push -u origin release/vX.Y.Z
gh pr create --base main --title "chore(release): vX.Y.Z" --body "..."
```

The body links the release's tracking issue (`Closes #N`) if there is one;
otherwise `Part of` the milestone's issues. Summarise the version, the bump
reason, and the specs shipped. Wait for CI and the PR checks, then merge with a
merge commit or squash (the tag goes on the resulting `main` commit). Merging
needs the user's go-ahead.

## 5 — Tag

```bash
git switch main && git pull --ff-only
gh run list --branch main --workflow CI -L 1    # wait for the release merge to publish its image
git tag -a vX.Y.Z -m "<short title of the release>"
git push origin vX.Y.Z
```

The annotated tag's message becomes the GitHub Release title
("vX.Y.Z — short title").

## 6 — Confirm it shipped

```bash
gh run list --workflow CI -L 1                  # the tag's run: "Tag release image" job
gh release view vX.Y.Z                          # notes = the CHANGELOG section
```

Then close the milestone:

```bash
gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -f state=closed
```

Report: the version, the release URL, the image tags published
(`X.Y.Z` and `stable`), the specs flipped to Shipped, and any issues moved to
the next milestone. A box tracking `APP_TAG=stable` picks the release up on its
next poll.

## If the release job fails

- **release:check failed** — the tag points at a commit that is not a finished
  release. Delete the tag (`git push --delete origin vX.Y.Z && git tag -d vX.Y.Z`),
  fix it through another PR, and tag again.
- **Timed out waiting for `sha-<short>`** — the release merge's image build
  failed or had not finished, or the tag is not on the release merge (only a
  release merge publishes). Get it green, then re-run the job.
