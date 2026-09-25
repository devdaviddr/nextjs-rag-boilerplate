# Contributing

Thanks for your interest in improving this project. For the full path from a
feature branch to a live deploy on your own box (this doc + Cloudflare
Tunnel, tied together), see [Feature → Production](docs/workflow.md).

## Getting set up

See [docs/usage.md](docs/usage.md) for prerequisites and the local setup. In short:

```bash
pnpm install
cp .env.example .env && npx auth secret   # paste into .env
pnpm docker:db && pnpm docker:minio && pnpm db:migrate && pnpm db:seed
pnpm dev
```

## Workflow

1. **Start from an issue.** Every change is the work of an issue in this repo,
   tracked on the project board. Find it, or file one: a `[Feature]` for new
   user-facing behaviour (under its `[Capability]`), or a `[Bug]`, `[Change]`,
   `[Chore]` or `[Spike]`. Move it to **In Progress** when you start.
2. For a non-trivial feature, write a spec first — copy
   [`specs/TEMPLATE.md`](specs/TEMPLATE.md) and open it as `Proposed`
   (see [`specs/README.md`](specs/README.md)).
3. Branch off `main` as `<type>/<issue#>-<slug>`, e.g. `feat/16-reranking` or
   `fix/18-minio-images`. There is no `develop` branch — `main` is the only
   long-lived branch, and it only changes through pull requests.
4. Make your change with tests where it makes sense. In the same branch, add a
   `CHANGELOG.md` entry under `[Unreleased]` for anything a user of the
   template can notice, and update the docs page that owns what you changed.
5. Run the full gate locally before pushing:

   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```

6. Open a pull request into `main` and fill in the template. The title is a
   Conventional Commit header, and the body says `Closes #N` (or `Part of #N`).
   CI runs the gate and the Playwright suite, and the **PR checks** job checks
   the title, every commit message, the issue link, and — for `feat`, `fix`,
   `perf`, `revert` or breaking changes — that `CHANGELOG.md` changed (add the
   `no-changelog` label if users cannot notice the change). Merge once it is
   all green. See [docs/ci-cd.md](docs/ci-cd.md).

## Releasing

Releases follow [Feature → Production § 5](docs/workflow.md#5--cut-a-release),
and the `/ship` skill in `.claude/skills/ship/` walks it for Claude Code. In
short: a `release/vX.Y.Z` PR bumps `package.json`, moves `[Unreleased]` into
`## [X.Y.Z] - YYYY-MM-DD`, flips finished specs to `Shipped` and passes
`pnpm release:check`; after it merges, an annotated `vX.Y.Z` tag on the merge
commit makes CI publish the release image and the GitHub Release.

### Versioning

[Semantic Versioning](https://semver.org). While the version is `0.x`, a
breaking change or a new feature bumps the minor and anything else bumps the
patch. From `1.0.0`: breaking → major, `feat` → minor, everything else → patch.
`pnpm release:next` reads the Conventional Commits since the last tag and
suggests the version by these rules.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org),
enforced by a `commit-msg` hook (commitlint). Examples:

```
feat: add password reset flow
fix(auth): reject expired reset tokens
docs: document the rate limiter
chore(deps): bump next to 16.3
```

A Husky `pre-commit` hook also runs ESLint + Prettier on staged files.

## Code style

- TypeScript strict mode; no `any` without justification.
- Prettier + ESLint are the source of truth — don't hand-format.
- Keep server-only code out of client components (`server-only` guards this).
