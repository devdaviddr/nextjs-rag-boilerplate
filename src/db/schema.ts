import { relations, sql } from 'drizzle-orm'
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

/** Ingestion states. `failed` always carries a human-readable `error`. */
export const DOCUMENT_STATUSES = [
  'pending',
  'extracting',
  'embedding',
  'ready',
  'failed',
] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export const documents = pgTable(
  'documents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The stored PDF blob. `cascade` so removing the file row can never leave
    // a document pointing at an object that no longer exists.
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    pageCount: integer('page_count'),
    status: text('status').$type<DocumentStatus>().notNull().default('pending'),
    // Populated only when status = 'failed'. User-facing, so it must stay
    // readable — no stack traces.
    error: text('error'),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('documents_owner_id_idx').on(table.ownerId),
    index('documents_status_idx').on(table.status),
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
    content: text('content').notNull(),
    // 1-based, matching what a reader sees in a PDF viewer. Chunks never span
    // a page boundary, so a citation is always exact.
    pageNumber: integer('page_number').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    tokenCount: integer('token_count').notNull(),
    embedding: halfvec('embedding', { dimensions: 2048 }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('chunks_owner_id_idx').on(table.ownerId),
    index('chunks_document_id_idx').on(table.documentId),
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
  retrieval: 'search' | 'document'
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
}))

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
export type ChunkRecord = typeof chunks.$inferSelect
export type NewChunkRecord = typeof chunks.$inferInsert
export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
