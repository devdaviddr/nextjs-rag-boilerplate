-- Spec 0025 — RAG knowledge base.
--
-- pgvector must exist before the halfvec column below can be created. The db
-- service image is pgvector/pgvector:pg17 for exactly this reason; the stock
-- postgres image does not ship the extension.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"content" text NOT NULL,
	"page_number" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" halfvec(2048) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"file_id" text NOT NULL,
	"title" text NOT NULL,
	"page_count" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_owner_id_idx" ON "chunks" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "chunks_document_id_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_owner_id_idx" ON "documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
-- HNSW over halfvec, NOT vector.
--
-- nemotron-3-embed-1b emits 2048 dimensions and refuses to emit fewer.
-- pgvector can only index a `vector` up to 2000 dimensions, so `vector(2048)`
-- would store fine and then silently sequential-scan every query. `halfvec`
-- indexes up to 4000. drizzle-kit cannot express `halfvec_cosine_ops` for a
-- custom type, so the index is declared here rather than in the schema.
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" halfvec_cosine_ops);
