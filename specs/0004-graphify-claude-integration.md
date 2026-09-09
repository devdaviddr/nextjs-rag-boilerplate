---
id: 0004
title: graphify & CLAUDE.md integration
status: Shipped
release: 'v0.3.1'
created: 2026-07-12
updated: 2026-07-12
---

# 0004 — graphify & CLAUDE.md integration

## Summary

Make AI assistants working in this repo consult the project's knowledge graph
before browsing source, and give them a concise, authoritative `CLAUDE.md` of
context and conventions — so assistance is grounded in the actual codebase and
follows the project's standards.

## Problem / motivation

Without repo-specific guidance, an assistant greps and reads files blindly,
misses conventions (the edge/node auth split, `proxy.ts`, Conventional Commits),
and can't be trusted to follow house rules. The repo already builds a graphify
knowledge graph; nothing directed assistants to use it.

## Goals

- Assistants orient via the graph before raw file exploration.
- A single, high-signal `CLAUDE.md` covering stack, commands, conventions, and
  the git workflow.
- Encode the rule that AI must not be credited in git history.

## Non-goals

- Replacing human judgement or requiring graphify for people who clone the repo.

## Requirements

### Functional

- **FR1** — `CLAUDE.md` documents stack, commands, architecture conventions, and
  the gitflow/commit rules.
- **FR2** — A harness hook nudges assistants to run `graphify query` before
  grepping/reading source when a graph exists.

### Non-functional

- **NFR1** — Must no-op safely for anyone who clones without graphify installed
  (the graph output is gitignored).
- **NFR2** — Tool-agnostic core: the deployment/runtime never depends on the
  assistant tooling.

## Design / approach

- `CLAUDE.md` with sections: what this is, stack (incl. the Turbopack-everywhere
  constraint), commands, architecture conventions, and Git & workflow —
  including "do not credit AI in commits/PRs".
- `.claude/settings.json` PreToolUse hooks on `Bash` (grep/find) and
  `Read`/`Glob` that inject a mandatory "query graphify first" reminder when
  `graphify-out/graph.json` exists; they no-op otherwise.
- Post-commit hook keeps the graph current (AST-only).

## Acceptance criteria

- [x] `graphify query`/`explain` return scoped, accurate subgraphs for the repo.
- [x] Hooks fire before source reads/greps when a graph is present.
- [x] Fresh clone without graphify: hooks no-op, no errors.

## Security & privacy

- Graph output stays local (gitignored). Hooks run only local, read-only checks.

## Alternatives considered

- **CLAUDE.md instructions alone** — soft; the PreToolUse hooks add real
  enforcement.
- **A bespoke Claude skill** — ties the feature to one assistant environment;
  kept as an optional personal wrapper instead.

## Out of scope / future

- Publishing the graph, semantic (LLM) extraction in CI.

## References

- Release: `v0.3.1`.
- Files: [`CLAUDE.md`](../CLAUDE.md), `.claude/settings.json`.
