# Specs — Spec-Driven Development

[← Back to README](../README.md)

**What this covers:** how design decisions get written down before they get
built, and the index of every spec in this repo.

This project uses **spec-driven development (SDD)**: non-trivial changes start
with a short written spec that captures the _what_ and _why_ before the _how_.
Specs make intent reviewable, keep scope honest, and give the codebase a
durable record of the decisions behind each release.

## When to write a spec

Write one for any **feature, cross-cutting change, or notable trade-off**
(new capability, security posture change, infra, breaking change). Skip it for
trivial fixes, dependency bumps, and copy edits — a good commit message is
enough there.

## Lifecycle

```
Proposed ──▶ Shipped
    │
    ├──▶ Rejected                    (decided against)
    └──▶ Superseded                  (a later spec replaces it)
```

- **Proposed** — drafted; the plan of record, not yet released.
- **Shipped** — released; `release:` records the version and the acceptance
  criteria are closed out.
- **Superseded / Rejected** — kept for history, with the status explaining why.

Two working states is what this project actually uses. An earlier version of
this document also defined `Accepted` and `In Progress`; nothing was ever
recorded in either, so they were removed rather than left as decoration.

## How to author one

1. Copy [`TEMPLATE.md`](TEMPLATE.md) to `NNNN-slug.md` (next free 4-digit id).
2. Fill it in; open it for review as `Proposed`.
3. On agreement, set `Accepted` and implement — ideally on a `feature/<slug>`
   branch (see the [contributing guide](../CONTRIBUTING.md) for the trunk-based
   workflow).
4. On release, set `Shipped`, fill `release:`, and **close out the acceptance
   criteria** — tick what is done, and move anything that is not into
   "Out of scope / future" with a reason. Add the matching
   [`CHANGELOG.md`](../CHANGELOG.md) entry, then run `pnpm specs:check`.

A tick is a claim, so cite what backs it — the test, script or migration that
makes it true. Specs [0028](0028-independent-knowledge-bases.md) and
[0029](0029-agentic-retrieval-loop.md) show the shape. Criteria that genuinely
cannot be verified stay unticked under a short note saying why; an open box with
a reason is honest, an open box with no explanation is just rot.

> **The index below is generated.** `status` and `release` live in each spec's
> frontmatter and nowhere else. Run `pnpm specs:index` to rewrite the table and
> `pnpm specs:check` to verify it is current — the latter also rejects an
> unknown status, a `Shipped` spec with no release, and template residue.

**Spec vs changelog:** the spec is the intent _before_ (why/what/how); the
changelog is the record _after_ (what shipped, for users). They complement each
other — one isn't a substitute for the other.

## Index

<!-- specs:index:start -->

| Spec                                                  | Title                                                                                | Status   | Release |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- | ------- |
| [0001](0001-project-foundation.md)                    | Project foundation                                                                   | Shipped  | v0.1.0  |
| [0002](0002-pwa-and-app-shell.md)                     | PWA & responsive app shell                                                           | Shipped  | v0.2.0  |
| [0003](0003-security-hardening.md)                    | Production security hardening                                                        | Shipped  | v0.3.0  |
| [0004](0004-graphify-claude-integration.md)           | graphify & CLAUDE.md integration                                                     | Shipped  | v0.3.1  |
| [0005](0005-cloudflare-tunnel-deployment.md)          | Cloudflare Tunnel deployment                                                         | Shipped  | v0.4.0  |
| [0006](0006-rbac.md)                                  | Role-Based Access Control (RBAC)                                                     | Shipped  | v0.5.0  |
| [0007](0007-file-uploads.md)                          | File uploads & object storage (MinIO)                                                | Shipped  | v0.6.0  |
| [0009](0009-automated-backups.md)                     | Automated backups (Postgres + MinIO)                                                 | Shipped  | v0.13.0 |
| [0010](0010-oauth-providers.md)                       | OAuth providers (GitHub, Google)                                                     | Shipped  | v0.10.0 |
| [0011](0011-email-verification-password-reset.md)     | Email verification & password reset                                                  | Shipped  | v0.11.0 |
| [0013](0013-dark-mode-theming.md)                     | Dark-mode toggle & theming                                                           | Shipped  | v0.8.0  |
| [0015](0015-web-push-notifications.md)                | Web Push notifications                                                               | Shipped  | v0.12.0 |
| [0017](0017-shared-store-rate-limiting.md)            | Shared-store rate limiting (Upstash)                                                 | Proposed | —       |
| [0018](0018-profile-photo-upload.md)                  | Profile photo upload                                                                 | Shipped  | v0.7.0  |
| [0019](0019-seo-opengraph-metadata.md)                | SEO & OpenGraph metadata                                                             | Shipped  | v0.9.0  |
| [0020](0020-one-click-self-hosting-setup.md)          | One-click self-hosting setup                                                         | Shipped  | v0.14.0 |
| [0021](0021-continuous-deployment-self-hosted.md)     | Continuous deployment for self-hosted instances                                      | Shipped  | v0.14.0 |
| [0022](0022-always-on-hardening-mac-mini.md)          | Always-on hardening for self-hosted Mac minis                                        | Shipped  | v0.15.0 |
| [0023](0023-tier-b-default-and-build-version.md)      | Pull-based deploy as the default + deployed build version in Settings                | Shipped  | v0.16.0 |
| [0024](0024-faster-time-to-deploy.md)                 | Faster time-to-deploy — re-tag on release, overlap build with e2e, tighter pull loop | Shipped  | v0.17.0 |
| [0025](0025-rag-knowledge-base-and-chat.md)           | PDF knowledge base & document chat (RAG)                                             | Shipped  | v0.20.0 |
| [0026](0026-chat-first-ux-and-history.md)             | Rag Boilerplate — chat-first UX, history and source viewing                          | Shipped  | v0.20.0 |
| [0027](0027-agentic-rag-and-document-cracking.md)     | Agentic RAG, document cracking and the evaluation that makes both provable           | Shipped  | v0.20.0 |
| [0028](0028-independent-knowledge-bases.md)           | Independent knowledge bases                                                          | Shipped  | v0.20.0 |
| [0029](0029-agentic-retrieval-loop.md)                | Agentic retrieval loop                                                               | Shipped  | v0.20.0 |
| [0030](0030-invalidate-sessions-for-deleted-users.md) | Invalidate sessions whose user no longer exists                                      | Shipped  | v0.20.1 |
| [0031](0031-tables-figures-and-complex-layouts.md)    | Index tables, figures and complex layouts                                            | Proposed | —       |

<!-- specs:index:end -->

> Specs 0001–0004 were written retroactively to document the decisions behind
> the existing releases; SDD is the going-forward process (0005 onward).
>
> **Ids are allocation order, not ship order.** A spec gets its number when it
> is written, and priorities moved after that — 0013 shipped in v0.8.0, 0018 in
> v0.7.0, 0009 not until v0.13.0. Read the Release column, not the row order,
> for the timeline.
>
> Numbering has gaps (0008, 0012, 0014, 0016) from descoped drafts — error
> tracking, Cloudflare Analytics, and i18n aren't planned right now; SEO
> metadata (originally 0008) was re-scoped for the portfolio use case as
> [0019](0019-seo-opengraph-metadata.md). The old numbers aren't reused. 0017 is
> written but intentionally not scheduled — see its "Non-goals".

### Releases without a spec

Two minor releases shipped without one, both CI changes made while the pipeline
itself was being reworked:

| Release   | What shipped                                               |
| --------- | ---------------------------------------------------------- |
| `v0.18.0` | Floating `stable` image tag, moved on every `v*` release   |
| `v0.19.0` | GitHub Releases generated by CI from the changelog section |

Both describe `ci.yml`, which has since been deleted from this fork
([docs/ci-cd.md](../docs/ci-cd.md)), so a retroactive spec would document
machinery that no longer exists. They are recorded here instead — the gap is
deliberate and visible rather than silent. `CHANGELOG.md` carries the detail.

---

**Next:** back to the [README](../README.md), or
[RAG — how it works](../docs/rag.md) for the retrieval design that specs
0025–0029 describe.
