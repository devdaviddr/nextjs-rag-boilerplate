<div align="center">

# Next.js RAG Boilerplate

**A production-ready Next.js 16 template for building grounded document chat —
with an optional agentic retrieval loop.**

![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-20232a?logo=react&logoColor=61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169e1?logo=postgresql&logoColor=white)
![pgvector](https://img.shields.io/badge/pgvector-HNSW-4169e1?logo=postgresql&logoColor=white)
![Auth.js](https://img.shields.io/badge/Auth.js-v5-000000?logo=auth0&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss&logoColor=white)
![NVIDIA NIM](https://img.shields.io/badge/NVIDIA_NIM-nemotron--3-76b900?logo=nvidia&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-ready-5a0fc8?logo=pwa&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green.svg)

[Getting started](#getting-started) · [Configuration](#configuration) ·
[Usage](#usage) · [Documentation](#documentation)

</div>

---

## What this is

A starter project for building a chat app that answers questions about your own
PDF files.

Clone it, add an API key, and you have a working app. People sign up, upload
PDFs into their own private collections, and ask questions about them. Every
answer shows the page it came from.

It works by searching your documents first, then asking the model to write an
answer using only what the search found. This is called RAG
(retrieval-augmented generation). If that's new to you, start with the
**[Tutorial](docs/tutorial.md)** — it explains everything from scratch.

Two rules are built into the code, so the model can't break them:

- **It won't make things up.** If nothing in your documents matches the
  question, the app says it doesn't know. The model isn't even called.
- **You only ever see your own documents.** That limit is part of the database
  query, not an instruction the model could be talked out of.

Sign-in, the database, file storage, offline support and Docker are already set
up. `pnpm rag:eval` scores how well the search is working.

---

## Getting started

**Prerequisites:** Node ≥ 20.9 (22 recommended) · [pnpm](https://pnpm.io)
(`corepack enable`) · Docker · an API key for an OpenAI-compatible endpoint
(a free [NVIDIA NIM](https://build.nvidia.com) key works — rate-limited, not
token-billed).

Run these in order from a fresh clone. Each step is safe to re-run.

```bash
# 1. Install dependencies
pnpm install

# 2. Configure the environment
cp .env.example .env
npx auth secret            # writes AUTH_SECRET into .env
# then set NVIDIA_API_KEY in .env

# 3. Start Postgres + MinIO, apply the schema, seed a demo user
pnpm docker:db
pnpm docker:minio
pnpm db:migrate
pnpm db:seed               # → demo@example.com / Password123

# 4. Run
pnpm dev                   # http://localhost:3000
```

Then, in the browser: sign in with `demo@example.com` / `Password123`, go to
`/documents` and create a knowledge base, upload a text PDF into it and wait
for its status to reach `ready`, then go to `/chat`, pick that knowledge base
and ask a question the document answers. Every answer cites the page it came
from. Now ask something the document does not cover — you get a refusal instead
of a guess, and that is the point of the whole exercise.

Without `NVIDIA_API_KEY` the app still boots — `/chat` and `/documents` report
themselves as unconfigured and the RAG test suites self-skip — so you can
evaluate the rest of the template first.

If anything here does not behave, the same sequence with the reasoning attached
is in **[Usage & Development](docs/usage.md)**, and the model configuration is
in **[RAG → Setup](docs/rag.md#setup)**.

---

## Configuration

All configuration is environment variables, validated at boot — the app fails
fast on a missing or malformed value rather than at first use. Start from
**[`.env.example`](.env.example)**, which documents every key inline; the full
table is in **[Usage → Environment variables](docs/usage.md#environment-variables)**.

### Required

| Variable       | Description                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string (pgvector extension required)                                   |
| `AUTH_SECRET`  | Auth.js signing secret — generate with `npx auth secret`                                     |
| `S3_ENDPOINT`  | S3-compatible endpoint; `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` alongside it |

In production also set `AUTH_URL` (canonical app URL), `APP_URL` (OpenGraph,
robots, sitemap) and `AUTH_TRUST_HOST=true` when TLS terminates at a trusted
proxy.

### Models and endpoint

| Variable           | Default                               | Description                                                                                 |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `NVIDIA_API_KEY`   | —                                     | API key for the inference endpoint; unset disables chat + documents                         |
| `RAG_LLM_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Any OpenAI-compatible base URL — point it at Ollama or llama.cpp to run fully offline       |
| `RAG_CHAT_MODEL`   | `nvidia/nemotron-3-super-120b-a12b`   | Writes the answer prose                                                                     |
| `RAG_EMBED_MODEL`  | `nvidia/nemotron-3-embed-1b`          | **Fixed at 2048 dimensions** — changing it requires a schema migration and a full re-ingest |

Running offline has two constraints: the embedding model must emit
2048-dimension vectors, and the planner model must emit native tool calls
reliably. See **[RAG → Setup](docs/rag.md#setup)**.

### Retrieval and agentic tuning

Chunking, `RAG_TOP_K`, the similarity floor, the hybrid candidate pool and the
agentic loop budgets are all optional and defaulted. `RAG_MIN_SIMILARITY`
(0.35) is the one worth tuning deliberately, and the agentic loop
(`RAG_AGENTIC_ENABLED`, off by default) is ~10× slower but far better on
follow-ups and multi-hop questions. Full tables, defaults and the measured
A/B: **[RAG → Tuning](docs/rag.md#tuning)** and
**[RAG → The agentic path](docs/rag.md#the-agentic-path)**.

### Optional features

Each block is inert until configured — none is required to run the app.

| Feature                 | Enable with                                                                      | Docs                                 |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| GitHub / Google OAuth   | `AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET`, `AUTH_GOOGLE_ID` + `AUTH_GOOGLE_SECRET` | [OAuth](docs/oauth.md)               |
| Email (reset, invites)  | `EMAIL_ENABLED=true` + `EMAIL_FROM` + `SMTP_HOST` + `SMTP_PORT`                  | [Email](docs/email.md)               |
| Email verification gate | `REQUIRE_EMAIL_VERIFICATION=true` (requires email enabled)                       | [Email](docs/email.md)               |
| Web Push                | `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + `VAPID_SUBJECT`                       | [Web Push](docs/push.md)             |
| Upload limits           | `UPLOAD_MAX_SIZE_MB`, `MAX_STORAGE_PER_USER_MB`, `UPLOAD_ALLOWED_MIME_TYPES`     | [Usage](docs/usage.md)               |
| Nightly backups         | `BACKUP_RETENTION_DAYS`, `BACKUP_INTERVAL_SECONDS`, `OFFSITE_BACKUP_*`           | [Backups](docs/backups.md)           |
| Cloudflare Tunnel       | `CLOUDFLARE_TUNNEL_TOKEN` + `AUTH_URL`                                           | [Deployment](docs/deployment.md)     |
| Pre-built image deploy  | `APP_IMAGE` + `APP_TAG`                                                          | [Self-hosting](docs/self-hosting.md) |

---

## Usage

The scripts you will actually reach for:

```bash
pnpm dev                   # dev server (Turbopack) at localhost:3000
pnpm build && pnpm start   # production build — required to exercise the PWA
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # verify the setup
pnpm rag:eval              # score retrieval against the ground-truth corpus
pnpm rag:eval --compare    # A/B the fixed and agentic retrieval paths
pnpm test:e2e              # Playwright — needs Postgres, MinIO, and Mailpit
```

Full script reference, testing notes and Docker workflow:
**[Usage & Development](docs/usage.md)**.

**Deployment.** The Docker stack is served on a Cloudflare domain via
Cloudflare Tunnel — no open ports, no reverse proxy, no certificates. `make
setup` walks a fresh clone to a live deployment (quick trial URL, your own
domain, or Terraform-provisioned); `make deploy` is continuous deployment
thereafter. See **[Self-hosting](docs/self-hosting.md)** and
**[Deployment](docs/deployment.md)**.

---

## Documentation

The table is in reading order, not alphabetical. If RAG is new to you, start at
the top and work down — the first four pages take you from nothing to a working
system you understand. If you have built retrieval before, jump straight to
[RAG](docs/rag.md) for the retrieval design,
[Architecture](docs/architecture.md) for the request flow and security model,
[Usage](docs/usage.md) for env vars and scripts, or
[Self-hosting](docs/self-hosting.md) to get it deployed.

| Doc                                             | What's inside                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| 🎓 **[Tutorial](docs/tutorial.md)**             | Start here — build up a working RAG system step by step               |
| 📄 **[Summary](docs/summary.md)**               | One-page project overview — stats, stack, what ships                  |
| 🛠️ **[Usage & Development](docs/usage.md)**     | Scripts, env vars, testing, Docker, extending the app                 |
| 🧠 **[RAG](docs/rag.md)**                       | Ingestion, index design, hybrid search, the agentic loop, evaluation  |
| 🗄️ **[Database](docs/database.md)**             | ERD, schema, migrations, Drizzle workflow, seeding                    |
| 🏛️ **[Architecture](docs/architecture.md)**     | Request flow, auth design, security model, project structure          |
| 📋 **[Features](docs/features.md)**             | Complete feature list and what's included                             |
| 🔑 **[OAuth](docs/oauth.md)**                   | GitHub + Google sign-in — setup, callback URLs, linking               |
| ✉️ **[Email](docs/email.md)**                   | SMTP setup, password reset, email verification, soft gate             |
| 📱 **[PWA & App Shell](docs/pwa.md)**           | Manifest, service worker strategy, icons, responsive shell            |
| 🔔 **[Web Push](docs/push.md)**                 | VAPID setup, subscribe/send, service-worker handlers                  |
| 📦 **[Self-hosting](docs/self-hosting.md)**     | `make setup` clone-to-live + continuous deployment (`make deploy`)    |
| 🚀 **[Deployment](docs/deployment.md)**         | Cloudflare Tunnel — quick, guided, and Terraform paths                |
| 💾 **[Backups](docs/backups.md)**               | Nightly Postgres + MinIO backups, restore runbook, offsite            |
| 🔁 **[Feature → Production](docs/workflow.md)** | One playbook: branch → PR → release → deploy                          |
| ⚙️ **[CI/CD](docs/ci-cd.md)**                   | _Removed in this fork_ — record of the former GitHub Actions pipeline |
| 📐 **[Specs](specs/README.md)**                 | Spec-driven development — one spec per feature/release                |

---

## Contributing

Commits run ESLint and Prettier through a Husky `pre-commit` hook. Before
opening a pull request run `pnpm lint && pnpm typecheck && pnpm test && pnpm
build`. Changes that touch retrieval should include a `pnpm rag:eval` run —
refusal accuracy is a hard gate, not a report line. See
**[CONTRIBUTING.md](CONTRIBUTING.md)** for conventions.

## License

Released under the [MIT License](LICENSE).

---

**Next:** if RAG is new to you, **[Tutorial](docs/tutorial.md)**. Otherwise
**[Summary](docs/summary.md)** for the whole project on one page.
