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

An opinionated application template, not a library. Clone it, point it at an
LLM endpoint, and you have a working multi-user document-chat product: users
register, upload PDFs into private knowledge bases they own, and hold
conversations answered only from those documents, with a page-level citation
for every claim.

Auth, PostgreSQL + pgvector, object storage, PWA, Docker and a retrieval
evaluation harness are already wired together. Two properties are enforced in
code rather than left to the model:

1. **An answer is grounded, or there is no answer.** If retrieval returns
   nothing above the similarity floor, the chat model is never called and a
   fixed refusal is returned.
2. **You can only retrieve your own documents.** Ownership and knowledge-base
   scope live in the SQL `WHERE` clause of every retrieval channel — not as a
   filter over results, and not as an instruction to the model.

Retrieval quality is measured, not asserted: `pnpm rag:eval` scores hit@k, MRR,
refusal accuracy and cross-knowledge-base leakage against a ground-truth
corpus. See **[Features](docs/features.md)** for the full inventory,
**[RAG](docs/rag.md)** for how retrieval works, and
**[Architecture](docs/architecture.md)** for the request flow and security
model.

---

## Getting started

**Prerequisites:** Node ≥ 20.9 (22 recommended) · [pnpm](https://pnpm.io)
(`corepack enable`) · Docker · an API key for an OpenAI-compatible endpoint
(a free [NVIDIA NIM](https://build.nvidia.com) key works — rate-limited, not
token-billed).

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

Without `NVIDIA_API_KEY` the app still boots — `/chat` and `/documents` report
themselves as unconfigured and the RAG test suites self-skip — so you can
evaluate the rest of the template first.

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

Sign in with the seeded demo account or register at `/register`, create a
knowledge base, upload a PDF, and start a conversation scoped to it. Every
answer cites the page it came from; a question the documents cannot answer is
refused rather than guessed.

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

| Doc                                             | What's inside                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| 🧠 **[RAG](docs/rag.md)**                       | Ingestion, index design, hybrid search, the agentic loop, evaluation  |
| 📋 **[Features](docs/features.md)**             | Complete feature list and what's included                             |
| 🏛️ **[Architecture](docs/architecture.md)**     | Request flow, auth design, security model, project structure          |
| 🗄️ **[Database](docs/database.md)**             | ERD, schema, migrations, Drizzle workflow, seeding                    |
| 🔑 **[OAuth](docs/oauth.md)**                   | GitHub + Google sign-in — setup, callback URLs, linking               |
| ✉️ **[Email](docs/email.md)**                   | SMTP setup, password reset, email verification, soft gate             |
| 📱 **[PWA & App Shell](docs/pwa.md)**           | Manifest, service worker strategy, icons, responsive shell            |
| 🔔 **[Web Push](docs/push.md)**                 | VAPID setup, subscribe/send, service-worker handlers                  |
| 🛠️ **[Usage & Development](docs/usage.md)**     | Scripts, env vars, testing, Docker, extending the app                 |
| 📦 **[Self-hosting](docs/self-hosting.md)**     | `make setup` clone-to-live + continuous deployment (`make deploy`)    |
| 🚀 **[Deployment](docs/deployment.md)**         | Cloudflare Tunnel — quick, guided, and Terraform paths                |
| ⚙️ **[CI/CD](docs/ci-cd.md)**                   | _Removed in this fork_ — record of the former GitHub Actions pipeline |
| 🔁 **[Feature → Production](docs/workflow.md)** | One playbook: branch → PR → CI → release → deploy                     |
| 💾 **[Backups](docs/backups.md)**               | Nightly Postgres + MinIO backups, restore runbook, offsite            |
| 📄 **[Summary](docs/summary.md)**               | One-page project overview — stats, stack, what ships                  |
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
