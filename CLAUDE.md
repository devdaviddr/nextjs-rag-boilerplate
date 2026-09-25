# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

A production-grade **Next.js 16** RAG boilerplate: grounded document chat over
PDFs in per-user knowledge bases, with page-level citations and an optional
agentic retrieval loop. Underneath it is a full-stack app — App Router + RSC +
Server Actions, Auth.js v5 credentials auth, Drizzle ORM on PostgreSQL +
pgvector, a PWA with a responsive app shell, and Docker. GitHub Actions runs
the gate on every PR (see [`docs/ci-cd.md`](docs/ci-cd.md)). Full docs live in
[`docs/`](docs/) — [`tutorial.md`](docs/tutorial.md) teaches the system end to
end and [`rag.md`](docs/rag.md) is the retrieval reference; read those before
large changes.

## Stack

Next.js 16 · React 19 · TypeScript 5.9 (strict) · Auth.js v5 (Credentials, JWT,
Argon2id) · Drizzle + Postgres 17 · Tailwind v4 + shadcn/ui · Zod · Vitest +
Playwright · pnpm. **Turbopack is used for both `dev` and `build`** — do not add
webpack-only tooling (this is why the service worker is hand-rolled, not Serwist).

## Commands

```bash
pnpm dev | build | start
pnpm lint | typecheck | format          # eslint · tsc --noEmit · prettier
pnpm test | test:e2e                     # Vitest (tests/unit) · Playwright (tests/e2e)
pnpm docker:db                           # local Postgres
pnpm db:generate | db:migrate | db:seed | db:studio
pnpm gen:icons                           # regenerate PWA icons
pnpm specs:index | specs:check           # regenerate · verify the spec index
pnpm docs:check                          # in-app docs: index + every link/anchor
pnpm release:next | release:check        # suggest the next version · check a release
pnpm pr:check                            # the PR check, locally (PR_TITLE / PR_BODY env)
```

Before pushing: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Architecture & conventions

- **Auth edge/node split.** `src/lib/auth/config.ts` is edge-safe (no DB, no
  argon2) and is consumed by `src/proxy.ts`. The Credentials provider + argon2 +
  DB live in `src/lib/auth/index.ts` (Node). Never import the DB or argon2 into
  `config.ts` or `proxy.ts`.
- **Route protection + CSP** live in `src/proxy.ts` (Next 16 renamed
  `middleware` → `proxy`). Add protected path prefixes there. CSP uses a
  per-request nonce — don't introduce inline scripts without it.
- **Session reads** go through `getCurrentSession()` (`src/lib/auth/session.ts`),
  which treats undecryptable cookies as signed-out but rethrows real errors.
- **Client-side session refresh**: `useSession().update()` called with **no
  argument** is just a GET re-fetch — it does **not** re-run the `jwt`
  callback's `trigger === 'update'` branch. Call `update({})` (any defined
  argument) to actually POST and trigger a server-side refresh (e.g. after a
  profile-photo change, `src/components/auth/avatar-upload.tsx`). Confirmed
  against the installed `next-auth` package source, not assumed.
- **Mutations** are Server Actions (`src/lib/auth/actions.ts`), not API routes.
- **Server Action errors a user must see**: return `{ ok: false, error }`
  (see `src/lib/auth/actions.ts`'s `AuthFormState`, `src/lib/storage/actions.ts`'s
  `ActionResult<T>`) — never `throw` for expected/validation failures. Next.js
  redacts a thrown Error's `message` in production builds, so a thrown
  validation error silently becomes "an error occurred" for the user. This
  only surfaces by testing the actual production build (`next start` /
  Docker), not `next dev` — do that before shipping any new Server Action
  with user-facing error messages. Reserve `throw` for genuinely unexpected
  failures (DB/S3 down), where redaction in production is correct.
- **Rate limiting** (`src/lib/rate-limit.ts`) is enforced in the server actions
  and in the credentials `authorize` callback (non-bypassable). It's in-memory
  (single-instance) — swap for a shared store if scaling out.
- **Env** is Zod-validated in `src/lib/env.ts` (fails fast). Add new vars to the
  schema _and_ `.env.example`.
- **AI settings** (`NVIDIA_API_KEY`, `RAG_LLM_BASE_URL`, `RAG_*`) are defined in
  `src/lib/ai-env.ts` and read with `aiSettings()` from `src/lib/ai-settings`
  (spec 0040 FR6), never `env.RAG_*`: a value saved in Settings overrides the
  env var, and `pnpm lint` rejects a direct read. Entry points (the chat route,
  the document actions, the eval) `await refreshAiSettings()` first.
- **Inference calls name their job**, not a model: `createChatCompletion(msgs,
{ role: 'planner' })`. The client resolves the job to its connection
  (endpoint + decrypted key) and model (`connectionFor`, `modelFor`), so a
  change in Settings → Models applies without touching call sites.
- **DB changes:** edit `src/db/schema.ts` → `pnpm db:generate` → commit the
  migration → `pnpm db:migrate`. Emails are stored lower-cased.
- **`server-only`** guards `src/db` and `src/lib/auth/password.ts` — never import
  them into client components.
- **PWA:** `public/sw.js` is hand-rolled and registers in **production only**;
  it never caches authenticated/API responses. The app shell is in
  `src/components/shell/`; nav is data-driven from `src/lib/shell/nav.ts`.
- **Structured logging** via `src/lib/logger.ts` — prefer it over `console.*`.

## Work tracking

All work is tracked as issues in this repo on the private project board
**"devdaviddr — Public repos"** (<https://github.com/users/devdaviddr/projects/11>).
Do not start a change that has no issue.

- **Find or file the issue first.** Product work is a tree: `[Pillar]` →
  `[Capability]` (users can …) → `[Feature]` (one user job), each linked to its
  parent as a sub-issue. Work outside the tree is a `[Bug]`, `[Change]`,
  `[Chore]` (internal: deps, tooling, refactors, docs) or `[Spike]`
  (time-boxed question ending in a decision). Title prefix and label match the
  kind. A Feature for new behaviour needs a spec first; its body names it
  (`Spec: specs/NNNN-slug.md`). If the `github-issue` skill is available, use
  it — it holds the board field ids and body templates.
- **Board fields.** New issues go on the board with Status `Todo`, and a
  Priority and Size when known. Move the issue to `In Progress` when work
  starts. Closing the issue (via the PR) moves it to `Done`.
- **Milestones** name the release an issue is planned for (`v0.21.0`).
- **Branch** off `main` as `<type>/<issue#>-<slug>` — `feat/16-reranking`,
  `fix/18-minio-images`, `chore/19-release-process`.
- **PR** into `main` with a Conventional Commit title, `Closes #N` (or
  `Part of #N`) in the body, and the template filled in. The `PR checks` job
  fails without the issue link, and fails a `feat`/`fix`/`perf`/`revert` or
  breaking PR that doesn't touch `CHANGELOG.md` unless it has the
  `no-changelog` label.
- **Never push to `main` directly.** A ruleset requires a PR with green CI.

## Git & workflow

- **Spec-driven.** Non-trivial features start with a spec in [`specs/`](specs/)
  (copy `specs/TEMPLATE.md`, status `Proposed` → `Shipped`, with `Superseded`
  and `Rejected` for a spec that stops being the plan of record). There is no
  `Accepted` state — `scripts/specs-index.mjs` rejects it and `pnpm specs:check`
  fails. A spec stays `Proposed` while it is implemented and flips to `Shipped`
  in the release PR. See [`specs/README.md`](specs/README.md).
- **Trunk-based.** `main` is the only long-lived branch (no `develop`). Work
  branches off `main` (naming above) and PRs back into it. CI (`ci.yml`)
  publishes the app + migrate images from every green `main`.
- **Conventional Commits**, enforced by a commitlint `commit-msg` hook locally
  and on every PR commit and title in CI. Keep commit **body lines ≤ 100
  characters**. A `pre-commit` hook runs lint-staged.
- **CHANGELOG.md** (Keep a Changelog): every user-facing change adds an entry
  under `[Unreleased]` in the same PR, not at release time.
- **Docs move with the code.** A PR that changes behaviour, setup, an env var,
  a command or a route updates the page that owns it: RAG → `docs/rag.md`,
  schema → `docs/database.md`, env vars → `.env.example` and
  `docs/usage.md`, auth/OAuth/email → `docs/features.md`, `docs/oauth.md`,
  `docs/email.md`, deploy/CI → `docs/self-hosting.md`, `docs/ci-cd.md`,
  `docs/workflow.md`. Also update `CLAUDE.md` when a convention here changes.
  `docs/*.md` is also the in-app **Docs** section (spec 0041): a new doc must
  be added to `DOC_SECTIONS` in `scripts/docs-lib.mjs`, and `pnpm docs:check`
  fails on any broken relative link or `#anchor`.

## Releasing

Run the `/ship` skill (`.claude/skills/ship/SKILL.md`); it walks every step
below. A **release is a `vX.Y.Z` tag on a `main` commit**, made in two parts:

1. **Release PR** from `release/vX.Y.Z`: `pnpm release:next` suggests the
   version from the Conventional Commits since the last tag; bump
   `package.json`; move `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD`
   (leaving an empty `[Unreleased]`); flip every spec whose criteria are all
   ticked to `Shipped` with `release: vX.Y.Z` and run `pnpm specs:index`;
   update version references in docs. `pnpm release:check` must pass. Title
   `chore(release): vX.Y.Z`.
2. **Tag** the merge commit once `main` is green:
   `git tag -a vX.Y.Z -m "<short title>" && git push origin vX.Y.Z`. CI's
   `release` job re-runs `release:check`, re-tags the image as the semver and
   `stable`, and creates the GitHub Release from the CHANGELOG section. Then
   close the milestone.

**Versioning** (SemVer, pre-1.0 while the version starts `0.`): a breaking
change or a `feat` bumps the minor, anything else the patch. From 1.0: breaking
→ major, `feat` → minor, else patch. `release:next` applies these rules.

`deploy.yml` is skipped unless the repo variable `SELF_HOSTED_DEPLOY` is
`'true'` (it is unset here, and this repo is public, where enabling it is
unsafe); the box's pull timer deploys instead — see
[`docs/ci-cd.md`](docs/ci-cd.md) and [`docs/workflow.md`](docs/workflow.md).

## Attribution

**Do NOT credit AI in git.** Never add `Co-Authored-By: Claude`, "Generated
with…", or any AI/assistant trailer to commits or PR descriptions.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
