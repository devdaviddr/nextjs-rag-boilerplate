Closes #

<!--
Every PR is the work of an issue on the project board. "Closes #N" closes it on
merge; use "Part of #N" when this PR is only a slice of it. The PR check fails
without one (bots are exempt).

Title: a Conventional Commit header, e.g. `feat(rag): add reranking`. It is
checked by commitlint, like every commit in the PR.
-->

## Summary

<!-- What does this PR do and why? -->

## Spec

<!-- `specs/NNNN-slug.md` and the criteria (FR / acceptance) this PR serves, or "None — not a spec'd change". -->

## Changes

-

## Release impact

- **Version bump:** <!-- none | patch | minor | major — see CONTRIBUTING.md → Versioning -->
- **CHANGELOG:** <!-- the entry added under [Unreleased], or why none is needed (and the no-changelog label) -->
- **Docs:** <!-- the docs/ pages, README or CLAUDE.md updated, or "none — no behaviour or setup change" -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass locally
- [ ] Added/updated tests where it makes sense
- [ ] Docs updated for any change in behaviour, setup, env vars or commands
- [ ] `CHANGELOG.md` updated under `[Unreleased]` for a user-facing change
- [ ] A spec this finishes has every acceptance criterion ticked, with evidence
- [ ] Commits and title follow Conventional Commits

## Notes for reviewers

<!-- Trade-offs, follow-ups, screenshots. -->
