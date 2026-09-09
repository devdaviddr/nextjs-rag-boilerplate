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

1. For a non-trivial feature, write a spec first — copy
   [`specs/TEMPLATE.md`](specs/TEMPLATE.md) and open it as `Proposed`
   (see [`specs/README.md`](specs/README.md)).
2. Branch off `main`: `feature/<slug>`. There is no `develop` branch — `main`
   is the only long-lived branch.
3. Make your change with tests where it makes sense.
4. Run the full gate locally before pushing:

   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```

5. Open a pull request into `main`. There is no CI in this fork and no status
   checks — the gate in step 4 is yours to run (see
   [docs/ci-cd.md](docs/ci-cd.md)). To cut a release, bump the version, set the
   spec to `Shipped`, update `CHANGELOG.md`, and push a `vX.Y.Z` tag on `main`
   — the tag defines the release (there's no required `Release vX.Y.Z` merge
   commit; v0.14.0+ tag a plain commit directly). The tag no longer triggers a
   deploy on its own: build and push the images yourself, then the box's pull
   timer picks them up (see
   [Feature → Production](docs/workflow.md) steps 4–6).

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
