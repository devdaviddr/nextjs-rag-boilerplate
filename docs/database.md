# Database

[← Back to README](../README.md)

PostgreSQL 17 accessed through [Drizzle ORM](https://orm.drizzle.team) with a `postgres-js` driver.

### Entity-Relationship Diagram

```mermaid
erDiagram
    users ||--o{ accounts : "OAuth links"
    users ||--o{ sessions : "has"
    users ||--o{ user_roles : ""
    roles ||--o{ user_roles : ""
    users ||--o{ files : "owns"
    users ||--o| files : "avatar_file_id"
    users ||--o{ push_subscriptions : "devices"
    users ||--o{ authenticators : "passkeys"
    users ||..o{ verification_tokens : "by email (not FK)"
    users ||--o{ knowledge_bases : "owns"
    users ||--o{ documents : "owns (denormalised)"
    users ||--o{ chunks : "owns (denormalised)"
    users ||--o{ conversations : "owns"
    knowledge_bases ||--o{ documents : "cascade"
    knowledge_bases ||--o{ chunks : "cascade (denormalised)"
    files ||--|| documents : "stored PDF"
    documents ||--o{ chunks : "cascade"
    conversations ||--o{ messages : "cascade"
    conversations ||--o{ conversation_knowledge_bases : "cascade"
    knowledge_bases ||--o{ conversation_knowledge_bases : "cascade"

    users {
        text id PK
        text email UK
        text name
        timestamp email_verified
        text image
        text avatar_file_id FK
        text hashed_password "null for OAuth-only"
        text invite_token_hash
        timestamp invite_expires
    }
    accounts {
        text provider PK
        text provider_account_id PK
        text user_id FK
        text access_token
        text refresh_token
    }
    sessions {
        text session_token PK
        text user_id FK
        timestamp expires
    }
    verification_tokens {
        text identifier PK "user email"
        text token PK "sha-256 hash"
        timestamp expires
        text purpose "password-reset | email-verify"
    }
    authenticators {
        text credential_id UK
        text user_id FK
        integer counter
    }
    roles {
        text id PK
        text name UK
        text description
    }
    user_roles {
        text user_id PK "FK"
        text role_id PK "FK"
    }
    files {
        text id PK
        text owner_id FK
        text bucket_key UK
        text mime_type
        bigint size_bytes
    }
    push_subscriptions {
        text id PK
        text user_id FK
        text endpoint UK
        text p256dh
        text auth
    }
    documents {
        text id PK
        text owner_id FK
        text file_id FK
        text title
        int page_count
        text status "pending|extracting|embedding|ready|failed"
        text error "user-readable, only when failed"
    }
    chunks {
        text id PK
        text document_id FK
        text owner_id FK "denormalised: every retrieval filters on it"
        text content "what a citation displays"
        text heading "detected section, prefixed to the EMBEDDED text only"
        tsvector content_tsv "generated; lexical half of hybrid retrieval, GIN"
        int page_number "1-based, citations resolve to this"
        int chunk_index
        int token_count
        halfvec embedding "2048 dims, HNSW cosine index"
    }
    conversations {
        text id PK
        text owner_id FK
        text title "derived from the first message"
        timestamp updated_at "Recents is ordered by this"
    }
    messages {
        text id PK
        text conversation_id FK
        text owner_id FK
        text role "user | assistant"
        text content
        jsonb citations "as resolved at answer time"
        jsonb metrics "tokens, tok/s, latency, model"
    }
```

### Schema Tables

| Table                          | Purpose                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `users`                        | Accounts with password, email, invites, avatar                                       |
| `accounts`                     | OAuth provider links (GitHub/Google)                                                 |
| `sessions`                     | Database sessions (unused under JWT strategy)                                        |
| `verification_tokens`          | Single-use tokens for password reset & email verification                            |
| `authenticators`               | WebAuthn/passkey credentials                                                         |
| `roles`                        | Roles: admin, member, viewer                                                         |
| `user_roles`                   | Many-to-many users ↔ roles                                                           |
| `files`                        | Uploaded file metadata + S3 storage                                                  |
| `push_subscriptions`           | Web Push subscriptions per device                                                    |
| `knowledge_bases`              | An independent, user-owned collection of documents                                   |
| `documents`                    | A PDF in one knowledge base + its ingestion status                                   |
| `chunks`                       | Indexed passages: `halfvec(2048)` embedding + generated `tsvector` for hybrid search |
| `conversations`                | Chat threads, ordered in Recents by `updated_at`                                     |
| `messages`                     | Turns, with stored citations and generation metrics                                  |
| `conversation_knowledge_bases` | Which knowledge bases a thread may search — fixed at creation                        |

### Migration Workflow

```bash
pnpm db:generate    # generates SQL migration
pnpm db:migrate     # applies pending migrations
pnpm db:push        # direct schema push (prototyping)
pnpm db:studio      # visual DB browser
```

**Key files:**

- `src/db/migrate.ts:23` - Migration runner (Docker entrypoint)
- `src/db/seed.ts` - Idempotent seed (roles admin/member/viewer + demo admin user)

### Important Features

#### Role-Based Access Control

- Roles carried as `roles: string[]` claim on JWT (no DB round-trip to read)
- Edge gating via `proxy.ts`
- Server-side guards in `src/lib/auth/rbac.ts`

#### File Storage

- MinIO (S3-compatible) for object storage
- Postgres `files` table for metadata
- Ownership-checked downloads
- Profile photos support via `users.avatar_file_id`

#### Security Features

- Passwords stored with Argon2id
- Email uniqueness enforced (case-insensitive)
- Verification tokens stored as SHA-256 hashes
- Invite-based account claim (passwordless)

### Database Commands

| Command             | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `pnpm docker:db`    | Start local Postgres                                 |
| `pnpm docker:minio` | Start local MinIO with bucket                        |
| `pnpm db:migrate`   | Apply migrations                                     |
| `pnpm db:seed`      | Seed demo user (`demo@example.com` / `Password123` ) |

### Production Setup

See [deployment.md](deployment.md) for production Docker configuration.
