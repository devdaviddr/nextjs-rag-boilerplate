import { type SQL, relations, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type { AdapterAccountType } from 'next-auth/adapters'

/**
 * Schema is intentionally compatible with the Auth.js Drizzle adapter table
 * conventions (users / accounts / sessions / verificationTokens) so OAuth
 * providers can be dropped in later without a migration rewrite. The
 * credentials flow only needs `users.hashedPassword`.
 */

export const users = pgTable(
  'users',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text('name'),
    // Stored lower-cased by the app layer; unique index enforces one account
    // per address regardless of casing at write time.
    email: text('email').notNull(),
    emailVerified: timestamp('email_verified', { mode: 'date' }),
    // Avatar URL. Populated by an OAuth provider, or by our own upload flow
    // (spec 0018) — set to `/api/files/{avatarFileId}` in that case.
    image: text('image'),
    // Operational pointer to which `files` row (if any) is the current
    // avatar, so replacing/removing one is an explicit swap rather than
    // parsing `image`'s URL. `set null` so a `files` row can never be
    // deleted while this points at it silently.
    avatarFileId: text('avatar_file_id').references(
      (): AnyPgColumn => files.id,
      { onDelete: 'set null' },
    ),
    // Null for accounts created purely via OAuth; set for credentials users.
    hashedPassword: text('hashed_password'),
    // Invite flow: an admin-created (passwordless) user can only claim their
    // account with this token. Stored hashed; cleared once the account is claimed.
    inviteTokenHash: text('invite_token_hash'),
    inviteExpires: timestamp('invite_expires', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('users_email_unique_idx').on(table.email),
    // Defense in depth: enforce case-insensitive uniqueness even if a row is
    // ever inserted without the app's email lowercasing.
    uniqueIndex('users_email_lower_idx').on(sql`lower(${table.email})`),
  ],
)

export const accounts = pgTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AdapterAccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountId] }),
    index('accounts_user_id_idx').on(table.userId),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    sessionToken: text('session_token').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
)

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    // We store the SHA-256 hash of the emailed token here, never the raw value.
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
    // Scopes a token to one flow so it can't be replayed cross-purpose. Null
    // for rows created by the Auth.js adapter (e.g. its own email flows).
    purpose: text('purpose').$type<'password-reset' | 'email-verify'>(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
)

export const authenticators = pgTable(
  'authenticators',
  {
    credentialID: text('credential_id').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerAccountId: text('provider_account_id').notNull(),
    credentialPublicKey: text('credential_public_key').notNull(),
    counter: integer('counter').notNull(),
    credentialDeviceType: text('credential_device_type').notNull(),
    credentialBackedUp: boolean('credential_backed_up').notNull(),
    transports: text('transports'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.credentialID] })],
)

export const roles = pgTable(
  'roles',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text('name').notNull().unique(),
    description: text('description'),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('roles_name_unique_idx').on(table.name)],
)

export const userRoles = pgTable(
  'user_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
)

export const files = pgTable(
  'files',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Object key in the S3-compatible bucket — `${ownerId}/${uuid}-${name}`.
    // Cascade-deleting the DB row does NOT delete the underlying object;
    // callers (see admin-actions.ts deleteUser) must remove the object first.
    bucketKey: text('bucket_key').notNull().unique(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('files_owner_id_idx').on(table.ownerId)],
)

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The push service endpoint URL — unique per browser/device subscription.
    endpoint: text('endpoint').notNull().unique(),
    // Web Push encryption keys from the browser's PushSubscription.
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('push_subscriptions_user_id_idx').on(table.userId)],
)

/**
 * pgvector's half-precision vector type (spec 0025).
 *
 * NOT a stylistic choice. The only embedding model reachable on a free NVIDIA
 * NIM account is `nemotron-3-embed-1b`, whose output is fixed at 2048
 * dimensions (it rejects `dimensions: 1024`). pgvector can only build an HNSW
 * or IVFFlat index on a `vector` up to 2000 dimensions — so `vector(2048)`
 * would store fine and then silently sequential-scan every query. `halfvec`
 * indexes up to 4000 dimensions; the fp16 recall cost is negligible next to
 * losing the index entirely.
 *
 * Drizzle has no built-in halfvec, so the wire format is handled here: the
 * driver sends and receives pgvector's `[1,2,3]` text representation.
 */
const halfvec = customType<{
  data: number[]
  driverData: string
  config: { dimensions: number }
}>({
  dataType(config) {
    return `halfvec(${config?.dimensions ?? 0})`
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value) as number[]
  },
})

/**
 * Postgres `tsvector`. Drizzle has no built-in type for it, and the column is
 * generated, so nothing ever writes to it from application code.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector'
  },
})

/** Ingestion states. `failed` always carries a human-readable `error`. */
export const DOCUMENT_STATUSES = [
  'pending',
  'extracting',
  'embedding',
  'ready',
  'failed',
] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/**
 * An independent, user-owned collection of documents (spec 0028).
 *
 * Names are deliberately NOT unique per owner: a "Taxes" per year is
 * legitimate, and a rename colliding would be a loud failure for a cosmetic
 * problem. The switcher shows counts and dates to disambiguate.
 */
export const knowledgeBases = pgTable(
  'knowledge_bases',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('knowledge_bases_owner_id_idx').on(table.ownerId)],
)

export const documents = pgTable(
  'documents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // A document lives in exactly one knowledge base (spec 0028). Many-to-many
    // would make a chunk's KB membership non-scalar, forcing either a join on
    // the retrieval hot path or a duplicated 2048-dim embedding per membership.
    // `moveDocument` makes refiling cheap so that constraint is liveable.
    knowledgeBaseId: text('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    // The stored PDF blob. `cascade` so removing the file row can never leave
    // a document pointing at an object that no longer exists.
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    pageCount: integer('page_count'),
    // Per-page progress (spec 0031 FR13). `status` alone is too coarse once a
    // page can cost an API call: an ingestion that takes minutes and reports
    // only "embedding" is indistinguishable from one that has hung.
    pagesProcessed: integer('pages_processed'),
    // How this document was actually read, page by page. See
    // `ExtractionSummary` — it is what makes a partially-cracked document
    // honest rather than quietly incomplete.
    extraction: jsonb('extraction').$type<ExtractionSummary>(),
    status: text('status').$type<DocumentStatus>().notNull().default('pending'),
    // Populated only when status = 'failed'. User-facing, so it must stay
    // readable — no stack traces.
    error: text('error'),
    // The claim (spec 0034 FR4). A worker takes a document by conditionally
    // stamping this, and refreshes it on every page it finishes, so a live
    // run keeps its claim fresh while a dead one lets it expire. NULL means
    // nothing holds this document.
    //
    // It is a lease, NOT a lock: a worker that hangs past the window has its
    // document claimed by another and both may finish. That is safe only
    // because the chunk write is a single delete-then-insert transaction
    // (NFR5) — the second commit wins and neither leaves duplicates.
    claimedAt: timestamp('claimed_at', { mode: 'date' }),
    // How many times ingestion has been started for this document. Bounds
    // automatic recovery (FR2): a file that reliably crashes the parser would
    // otherwise be retried forever against a shared rate limit.
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('documents_owner_id_idx').on(table.ownerId),
    index('documents_status_idx').on(table.status),
    index('documents_knowledge_base_id_idx').on(table.knowledgeBaseId),
    // The recovery sweep's only query: transient status, expired claim. Both
    // columns together, because status alone selects every `ready` document
    // in the table and there are far more of those.
    index('documents_status_claimed_at_idx').on(table.status, table.claimedAt),
  ],
)

/**
 * What a chunk is, which decides how it may be used (spec 0031 FR8).
 *
 * - `text`  — the document's own prose.
 * - `table` — the document's own tabular markup, kept whole.
 * - `ocr`   — the document's own words, recovered from an image of them.
 * - `figure`— **a search key, not evidence.** Written to make a figure
 *   findable; its pixels are read at answer time by `read_figure`.
 */
export const CHUNK_KINDS = ['text', 'table', 'figure', 'ocr'] as const
export type ChunkKind = (typeof CHUNK_KINDS)[number]

/** A region of a page, normalised 0–1 with the origin at the top-left. */
export interface ChunkBox {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

/** How one page of a document was processed (spec 0031 FR11). */
export interface ExtractionPage {
  page: number
  route: 'clean-text' | 'structured' | 'image-heavy' | 'no-text'
  /** What actually happened, which is not always what the route asked for. */
  outcome: 'text-layer' | 'parsed' | 'budget-skipped' | 'failed'
  reason?: string
}

/**
 * A per-document record of how it was ingested.
 *
 * Exists so "indexed" and "fully indexed" are distinguishable. A document that
 * hit its cracking budget is still `ready` and still useful, but a user is
 * entitled to know some of it was read the cheap way.
 */
export interface ExtractionSummary {
  pages: ExtractionPage[]
  /** Pages that consumed cracking budget, cached or not — see `cachedPages`. */
  parseCalls: number
  describeCalls: number
  /**
   * Of `parseCalls`, how many were served from `parsedPages` instead of the
   * endpoint (spec 0034 FR3). Optional because rows written before resumable
   * ingestion existed do not have it, and absent is not the same as zero.
   */
  cachedPages?: number
  budgetExhausted: boolean
}

/**
 * One element as the layout parser returned it.
 *
 * Structurally identical to `ParsedElement` in `src/lib/rag/parse-types.ts`,
 * and deliberately re-declared rather than imported: drizzle-kit loads this
 * file outside Next.js, where the `@/` alias is not guaranteed to resolve, and
 * a schema that only compiles inside the app is a schema that cannot generate
 * a migration.
 */
export interface ParsedPageElement {
  type: string
  text: string
  bbox: ChunkBox
}

/**
 * The parse cache — the half of resumability that actually saves money
 * (spec 0034 FR3).
 *
 * Keyed by file and page, not by document: parser output is a pure function of
 * the page image, and the page image is a pure function of the immutable
 * uploaded bytes. So an entry can never be wrong for its key, only absent —
 * which is why this needs no invalidation beyond `renderScale` below.
 *
 * Without it a restart mid-crack re-pays every parse call from page 1, because
 * `crackDocument` holds its output in memory and only the final transaction
 * persists anything. With it, a document that cracked 20 of 25 pages resumes
 * having already bought those 20.
 *
 * Rows cascade with the file so the cache can never outlive the bytes it
 * describes, and ingestion drops a document's entries once it reaches `ready` —
 * at that point the chunks are the durable artefact and this is just bulk.
 */
export const parsedPages = pgTable(
  'parsed_pages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** 1-based, matching `ExtractionPage.page` and every citation. */
    page: integer('page').notNull(),
    // The render scale the parser actually saw. A page rasterised at 1.5x and
    // one at 2.0x are different inputs, so an entry written under one scale
    // must not be served under another — otherwise changing
    // RAG_CRACK_RENDER_SCALE silently keeps serving the old resolution's
    // output forever, and the setting appears to do nothing.
    renderScale: real('render_scale').notNull(),
    elements: jsonb('elements').$type<ParsedPageElement[]>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // One row per page, so a re-parse overwrites rather than accumulating.
    uniqueIndex('parsed_pages_file_id_page_idx').on(table.fileId, table.page),
  ],
)

export const chunks = pgTable(
  'chunks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    // Denormalised from `documents.ownerId` on purpose: every retrieval query
    // filters on it, and a join would put tenant isolation one refactor away
    // from being dropped. See spec 0025 NFR1.
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Denormalised from `documents.knowledgeBaseId` for exactly the same reason
    // `ownerId` above is denormalised (spec 0028 NFR1). Both retrieval channels
    // query `chunks` directly — the dense one under an HNSW index where the
    // filter is applied after the ANN scan, the lexical one under a GIN bitmap
    // scan. Reaching KB membership through a join to `documents` puts a
    // per-candidate lookup on the hot path and, as data grows, invites the
    // planner to abandon the index entirely: correct results, silently
    // degrading, no error. Same failure shape as the `vector`/`halfvec` trap.
    knowledgeBaseId: text('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    // Detected section heading for the page (spec 0027, 1a). Prefixed to the
    // EMBEDDED text, never to the displayed text, so a citation shows the
    // document's own words.
    heading: text('heading'),
    // The caption bound to a table or figure, or — for a caption-less figure —
    // the one-sentence label a vision model wrote at ingestion (spec 0038 FR1).
    //
    // Stored because it is what the chunk is FOUND by. It is prefixed to the
    // embedded text exactly as `heading` is, and before spec 0038 that was the
    // only place it existed: a ~40-second vision call produced a sentence that
    // reached one vector and was then discarded, unreadable by a citation, an
    // inspector, or the lexical index. NULL for a chunk that never had one, and
    // for every row written before this column existed.
    caption: text('caption'),
    // Lexical half of hybrid retrieval (spec 0027, 1b; widened by spec 0038
    // FR3). Generated, so it can never drift from the columns it derives from.
    //
    // Heading and caption are in here because they are in the EMBEDDED text.
    // While this read `content` alone, the two halves of hybrid retrieval
    // searched different documents: a query naming a section or quoting a
    // caption could be found by the dense half and was invisible to the
    // lexical one. Measured 2026-09-11 on `rag-cracking-test`, a caption-only
    // query scored 0.650 dense against the right figure and matched no row
    // lexically at all.
    contentTsv: tsvector('content_tsv').generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce(${chunks.heading}, '') || ' ' || coalesce(${chunks.caption}, '') || ' ' || ${chunks.content})`,
    ),
    // 1-based, matching what a reader sees in a PDF viewer. Chunks never span
    // a page boundary, so a citation is always exact.
    pageNumber: integer('page_number').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    tokenCount: integer('token_count').notNull(),
    // What this chunk IS (spec 0031 FR8), because the four kinds must be
    // treated differently and a caller cannot infer the difference from text.
    // `figure` above all: its content is a search key written to make the
    // figure findable, NOT the document's own words, so a citation must
    // present it as a description and an answer must never quote a number
    // from it. Defaults to 'text' so every existing row stays correct.
    kind: text('kind').$type<ChunkKind>().notNull().default('text'),
    // Where on the page this chunk came from, normalised 0–1
    // (`{xmin,ymin,xmax,ymax}`). Null for chunks produced by the text-layer
    // path, which has no boxes. This is what span-level citation highlighting
    // needs — deferred in spec 0026 for exactly the reason that nothing was
    // capturing it.
    bbox: jsonb('bbox').$type<ChunkBox>(),
    // The FULL list of regions this chunk came from (spec 0035 FR6).
    //
    // `bbox` above holds a single rectangle and cannot express a chunk that
    // spans two columns — a union there covers the gutter and the wrong
    // column, which is the "confidently wrong highlight" 0035 says is worse
    // than no highlight at all. Both columns exist for as long as rows written
    // before this do: `src/lib/citations/boxes.ts` is the single reader that
    // reconciles them, and a null here falls back to `bbox`.
    boxes: jsonb('boxes').$type<ChunkBox[]>(),
    // Where the heading and the caption sit on the page (spec 0038 FR2).
    //
    // Separate from `boxes` rather than appended to it, because they are not
    // the same claim. `boxes` says "this text is in the index as a passage";
    // these say "this text was indexed as context for that passage". Merging
    // them would draw a heading as though a question could retrieve it on its
    // own. Null for the text-layer path, which has no boxes at all, and for
    // every row written before this column existed.
    headingBbox: jsonb('heading_bbox').$type<ChunkBox>(),
    captionBbox: jsonb('caption_bbox').$type<ChunkBox>(),
    embedding: halfvec('embedding', { dimensions: 2048 }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // Leads with ownerId, so owner-only queries still use it and nothing
    // regresses; owner+KB queries get the composite for free. Replaces the
    // old single-column chunks_owner_id_idx.
    index('chunks_owner_kb_idx').on(table.ownerId, table.knowledgeBaseId),
    index('chunks_document_id_idx').on(table.documentId),
    index('chunks_content_tsv_idx').using('gin', table.contentTsv),
    // The HNSW index itself is created in the migration — drizzle-kit cannot
    // express `halfvec_cosine_ops` for a custom type.
  ],
)

/** Who authored a message. */
export const MESSAGE_ROLES = ['user', 'assistant'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]

/**
 * A citation as it was resolved at answer time (spec 0026 FR12).
 *
 * Stored on the message rather than recomputed, so reopening a conversation
 * shows the sources the answer was actually built from — even if the document
 * has since been deleted or re-ingested into different chunks.
 */
export interface StoredCitation {
  index: number
  chunkId: string
  documentId: string
  documentTitle: string
  pageNumber: number
  similarity: number
}

/** Mirrors MessageMetrics in lib/chat/metrics.ts. */
export interface StoredMetrics {
  model: string
  promptTokens: number | null
  completionTokens: number | null
  timeToFirstTokenMs: number | null
  totalMs: number
  tokensPerSecond: number | null
  sourceCount: number
  retrieval: 'search' | 'document' | 'agentic'
}

export const conversations = pgTable(
  'conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Derived from the first user message; editable. See lib/chat/title.ts.
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    // Bumped on every new message, because Recents is ordered by activity
    // rather than by creation.
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Exactly how the Recents list is read: this owner, newest activity first.
    index('conversations_owner_updated_idx').on(table.ownerId, table.updatedAt),
  ],
)

/**
 * Which knowledge bases a conversation may search (spec 0028 FR5).
 *
 * A join table rather than a jsonb array on `conversations`: the array reads
 * more simply and gives no referential integrity, so deleting a KB would leave
 * a dangling id in every conversation that ever selected it, cleaned up by
 * app-level sweep code. This schema avoids that kind of bookkeeping elsewhere.
 * The join is read once per chat page load, never inside a retrieval query.
 *
 * Selection is fixed when the conversation is created, so every message in a
 * thread has one auditable scope.
 */
export const conversationKnowledgeBases = pgTable(
  'conversation_knowledge_bases',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.knowledgeBaseId] }),
    // The PK leads with conversationId, so "which conversations use this KB"
    // needs its own index — same shape as accounts_user_id_idx.
    index('conversation_kb_kb_id_idx').on(table.knowledgeBaseId),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // Denormalised for the same reason `chunks.ownerId` is: every read filters
    // on it, and a join is one refactor away from being dropped.
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<MessageRole>().notNull(),
    content: text('content').notNull(),
    // Empty for user messages.
    citations: jsonb('citations')
      .$type<StoredCitation[]>()
      .notNull()
      .default([]),
    // Generation metrics (tokens, tok/s, latency). Null for user messages and
    // for assistant messages answered without calling the model.
    metrics: jsonb('metrics').$type<StoredMetrics>(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('messages_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
    index('messages_owner_id_idx').on(table.ownerId),
  ],
)

// Drizzle relations — required for `db.query.*` relational queries with `with`.
// These are ORM-only (no database migration).
export const usersRelations = relations(users, ({ many }) => ({
  userRoles: many(userRoles),
  files: many(files),
  documents: many(documents),
  conversations: many(conversations),
  knowledgeBases: many(knowledgeBases),
}))

export const knowledgeBasesRelations = relations(
  knowledgeBases,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [knowledgeBases.ownerId],
      references: [users.id],
    }),
    documents: many(documents),
    chunks: many(chunks),
    conversations: many(conversationKnowledgeBases),
  }),
)

export const filesRelations = relations(files, ({ one }) => ({
  owner: one(users, {
    fields: [files.ownerId],
    references: [users.id],
  }),
}))

export const documentsRelations = relations(documents, ({ one, many }) => ({
  owner: one(users, {
    fields: [documents.ownerId],
    references: [users.id],
  }),
  file: one(files, {
    fields: [documents.fileId],
    references: [files.id],
  }),
  knowledgeBase: one(knowledgeBases, {
    fields: [documents.knowledgeBaseId],
    references: [knowledgeBases.id],
  }),
  chunks: many(chunks),
}))

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [conversations.ownerId],
      references: [users.id],
    }),
    messages: many(messages),
    knowledgeBases: many(conversationKnowledgeBases),
  }),
)

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}))

export const chunksRelations = relations(chunks, ({ one }) => ({
  document: one(documents, {
    fields: [chunks.documentId],
    references: [documents.id],
  }),
}))

export const rolesRelations = relations(roles, ({ many }) => ({
  userRoles: many(userRoles),
}))

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, {
    fields: [userRoles.userId],
    references: [users.id],
  }),
  role: one(roles, {
    fields: [userRoles.roleId],
    references: [roles.id],
  }),
}))

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Role = typeof roles.$inferSelect
export type NewRole = typeof roles.$inferInsert
export type UserRole = typeof userRoles.$inferSelect
export type NewUserRole = typeof userRoles.$inferInsert
export type FileRecord = typeof files.$inferSelect
export type NewFileRecord = typeof files.$inferInsert
export type PushSubscription = typeof pushSubscriptions.$inferSelect
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert
export type DocumentRecord = typeof documents.$inferSelect
export type NewDocumentRecord = typeof documents.$inferInsert
export type ParsedPageRecord = typeof parsedPages.$inferSelect
export type NewParsedPageRecord = typeof parsedPages.$inferInsert
export type ChunkRecord = typeof chunks.$inferSelect
export type NewChunkRecord = typeof chunks.$inferInsert
export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
