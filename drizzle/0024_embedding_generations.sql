CREATE TABLE "chunk_embeddings" (
	"chunk_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"knowledge_base_id" text NOT NULL,
	"embedding" halfvec NOT NULL,
	CONSTRAINT "chunk_embeddings_chunk_id_generation_id_pk" PRIMARY KEY("chunk_id","generation_id")
);
--> statement-breakpoint
CREATE TABLE "embedding_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text,
	"dimensions" integer NOT NULL,
	"status" text NOT NULL,
	"total_chunks" integer DEFAULT 0 NOT NULL,
	"embedded_chunks" integer DEFAULT 0 NOT NULL,
	"error" text,
	"claimed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "embedding" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_generation_id_embedding_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."embedding_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_generations" ADD CONSTRAINT "embedding_generations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_embeddings_generation_idx" ON "chunk_embeddings" USING btree ("generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_generations_one_active_idx" ON "embedding_generations" USING btree ("status") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_generations_one_building_idx" ON "embedding_generations" USING btree ("status") WHERE status = 'building';--> statement-breakpoint
-- #56: the vectors already in `chunks` become the first generation. Its model
-- is left null: it is whatever RAG_EMBED_MODEL names, as it always was.
INSERT INTO "embedding_generations" ("id", "model", "dimensions", "status", "total_chunks", "embedded_chunks", "activated_at")
SELECT 'initial', NULL, 2048, 'active', count(*), count(*), now() FROM "chunks";--> statement-breakpoint
INSERT INTO "chunk_embeddings" ("chunk_id", "generation_id", "owner_id", "knowledge_base_id", "embedding")
SELECT "id", 'initial', "owner_id", "knowledge_base_id", "embedding" FROM "chunks" WHERE "embedding" IS NOT NULL;--> statement-breakpoint
-- One HNSW index per generation, on its own rows at its own size (#64).
CREATE INDEX "chunk_embeddings_initial_hnsw_idx" ON "chunk_embeddings" USING hnsw (("embedding"::halfvec(2048)) halfvec_cosine_ops) WHERE "generation_id" = 'initial';
