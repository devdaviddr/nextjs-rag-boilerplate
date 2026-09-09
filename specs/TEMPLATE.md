---
id: NNNN
title: <Short, imperative title>
status: Proposed # Proposed | Shipped | Superseded | Rejected
release: '—' # e.g. v0.4.0 once shipped
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# NNNN — <Title>

## Summary

One paragraph: what this change is and why, in plain language.

## Problem / motivation

What's wrong or missing today, and who feels it. Evidence over opinion.

## Goals

- What success looks like (bullet, testable where possible).

## Non-goals

- Explicitly out of scope, to prevent scope creep.

## Requirements

### Functional

- **FR1** — …
- **FR2** — …

### Non-functional

- **NFR1** — (performance, security, a11y, DX, …)

## Design / approach

The technical approach and the decisions that matter. Reference concrete files
and modules (`src/…`). Call out anything a reviewer must not get wrong.

## Acceptance criteria

Tick these on release and cite what backs each one — the test, script or
migration that makes it true, so a tick can be re-checked later. A criterion
that cannot be verified stays unticked under a
`> **Not verified (YYYY-MM-DD).**` note saying why; `pnpm specs:check` warns
about open boxes with no such note.

- [ ] Observable, testable condition … — `path/to/the.test.ts`
- [ ] …

## Security & privacy

Threats considered and how they're handled (or why N/A).

## Alternatives considered

- **Option X** — why not.

## Out of scope / future

- Follow-ups intentionally deferred.

## References

- Release/tag, key commits or PRs.
- Related specs, docs, or external sources.
