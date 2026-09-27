# Starting your own project

**What this covers:** turning a copy of this repository into your own project.
It covers what to rename, the one string you must not rename, which files are
the upstream maintainer's own workflow and can go, and how to switch off the
parts you don't need.

Start with **Use this template** on GitHub, or clone the repository and point
`origin` at your own. Then work through the sections below in order. None of it
is needed to _run_ the app; [Usage & Development](usage.md) gets you to a first
answer. This page is for when the project becomes yours.

## Rename it

The product's name and description live in one file, and most of the app
reads them from there. The rest is a short list.

| What                         | Where                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Name and description         | `src/lib/brand.ts` (`APP_NAME`, `APP_SHORT_NAME`, `APP_DESCRIPTION`)           |
| Package name                 | `package.json` → `name`                                                        |
| Browser theme colour         | `src/app/layout.tsx` → `viewport.themeColor`                                   |
| Installed-app colours        | `src/app/manifest.ts` → `background_color`, `theme_color`                      |
| UI colour tokens             | `src/app/globals.css` (`--primary`, `--background` and the rest)               |
| App icons                    | `scripts/generate-icons.mjs` (colours, mark), then `pnpm gen:icons`            |
| Share image                  | `pnpm gen:og` after renaming (it reads `APP_NAME`), or replace `public/og.png` |
| Links out of the in-app docs | `scripts/docs-lib.mjs` → `REPO_URL`                                            |
| Container image              | `APP_IMAGE` in `.env` on your server, if you deploy the published image        |

Then run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, which catches
anything half-renamed.

## Don't rename this one string

`src/lib/ai-settings/crypto.ts` has a constant:

```ts
const SALT = 'nextjs-rag-boilerplate/ai-settings'
```

It looks like the project's name, and a find-and-replace of the old name will
catch it. It is a fixed label mixed into the key that encrypts API keys saved
from Settings. Change it and every saved key becomes unreadable: Settings then
asks for each one again. Leave it exactly as it is. It is never shown to
anyone.

## The upstream maintainer's workflow

Some files exist for how this repository itself is run. They are harmless, but
you may not want them.

| What                                                 | Files                                                                                                      | Keep?                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| graphify, a code-graph tool for AI assistants        | `.claude/settings.json`, `.husky/post-commit`, `.husky/post-checkout`, the graphify section of `CLAUDE.md` | Delete unless you use graphify. The hooks do nothing without it installed but print a message on every commit. |
| The maintainer's issue board and release routine     | `CLAUDE.md` → _Work tracking_ and _Releasing_, `.claude/skills/ship`, `.opencode/`                         | Rewrite `CLAUDE.md` for your own rules; the conventions sections are worth keeping.                            |
| PR rules: an issue link and a CHANGELOG entry per PR | `.github/workflows/pr.yml`, `scripts/pr-check.mjs`                                                         | Keep for a team; for a solo project, relax or delete.                                                          |
| Push-button deploy from a self-hosted runner         | `.github/workflows/deploy.yml`                                                                             | Skipped unless the `SELF_HOSTED_DEPLOY` variable is `true`. Delete if you won't use it.                        |
| Self-hosting setup for a Mac mini                    | `scripts/macos-*.sh`, `make autostart`, `make deploy-timer`                                                | Only for a macOS host. Harmless elsewhere.                                                                     |
| The project's history                                | `specs/`, `CHANGELOG.md`                                                                                   | Upstream history, not yours. Start `CHANGELOG.md` fresh from `[Unreleased]`, and keep or archive `specs/`.     |

Worth keeping as they are: Conventional Commits with the commitlint hook,
lint-staged, the CI quality gate (`.github/workflows/ci.yml` publishes images to
your own repository's registry), Renovate, `specs/TEMPLATE.md`, `pnpm docs:check`
and `pnpm release:next` / `pnpm release:check`.

## Taking fixes from upstream

Your project and this repository diverge from the first commit, but fixes
keep landing here, security fixes included. Keep this repository as a second
remote and merge its releases when you want them:

```bash
git remote add upstream https://github.com/devdaviddr/nextjs-rag-boilerplate.git
git fetch upstream --tags
git merge vX.Y.Z           # a release tag, not upstream's main
```

A repository made with **Use this template** starts with its own history, so
the first merge needs `git merge --allow-unrelated-histories vX.Y.Z`, and
conflicts everywhere you changed a file. Take upstream's version of files you
never touched; later merges are ordinary.

Merge release tags rather than `main`: a tag is a version whose CHANGELOG
section says what changed. Read that section first. Each release's notes are
the GitHub Release, and a release whose title starts with **Security:** has a
`### Security` section you should take soon. Pull the release's migrations
with the code, then run `pnpm db:migrate`.

Merges stay small if you leave upstream's files alone where you can:

- **Add, don't edit.** Put your own pages, components and actions in new
  files and folders. Wire them in with the smallest possible change to
  upstream's files (a nav entry in `src/lib/shell/nav.ts`, a route prefix in
  `src/proxy.ts`).
- **Most-changed upstream:** `src/lib/rag/`, `src/lib/auth/`,
  `src/lib/ai-settings/`, `src/app/api/chat/`, `eval/` and `docs/`. Changes
  there are the ones most likely to conflict, so keep yours there small, or
  expect to resolve them by hand.
- **Migrations:** never edit an upstream migration in `drizzle/`. Add your
  own with `pnpm db:generate` after upstream's, and after a merge regenerate
  if both sides added one.

If you'd rather not merge at all, cherry-pick the commits a release lists
(`git cherry-pick <sha>`). That suits a security fix in a project that has
moved far from upstream.

## Switch off what you don't need

Everything optional is off until configured, or can be switched off, from
`.env`. No code changes.

| Feature                        | How                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------- |
| GitHub / Google sign-in        | Leave `AUTH_GITHUB_*` / `AUTH_GOOGLE_*` unset (off by default)                  |
| Email (invites, reset, verify) | Leave `EMAIL_ENABLED` unset (off by default)                                    |
| Web Push                       | Leave `VAPID_*` unset (off by default)                                          |
| S3 / MinIO                     | Leave `S3_*` unset: files go to local disk under `STORAGE_DIR`                  |
| Installable app (PWA)          | `PWA_ENABLED=false`                                                             |
| Admin Observability pages      | `OBSERVABILITY_UI_ENABLED=false`                                                |
| Keeping logs in Postgres       | `LOG_PERSIST=false`                                                             |
| The agentic retrieval loop     | `RAG_AGENTIC_ENABLED=false` (on by default); see [RAG](rag.md#the-agentic-path) |
| Reranking, document cracking   | Off by default: `RAG_RERANK_ENABLED`, `RAG_CRACK_ENABLED`                       |

Roles (`admin`, `member`, `viewer`) are used throughout and are not meant to be
removed; a single-user deployment just has one admin.

**Next:** [Usage & Development](usage.md) to run it, then
[Self-hosting](self-hosting.md) to put it online.
