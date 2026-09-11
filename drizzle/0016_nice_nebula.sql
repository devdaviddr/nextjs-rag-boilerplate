-- Spec 0038. Hand-ordered: drizzle-kit emitted the `content_tsv` rebuild BEFORE
-- the `caption` column its new expression references, which cannot run, and did
-- not recreate the GIN index that dropping the column takes with it.
ALTER TABLE "chunks" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "heading_bbox" jsonb;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "caption_bbox" jsonb;--> statement-breakpoint
-- A generated column cannot be altered in place, so it is dropped and re-added.
-- Every existing row is re-derived from columns it already has: `heading` is
-- populated, `caption` is null, `content` is unchanged — so no row loses a
-- lexical match it had before, and rows with a heading gain one.
ALTER TABLE "chunks" DROP COLUMN "content_tsv";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "content_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("chunks"."heading", '') || ' ' || coalesce("chunks"."caption", '') || ' ' || "chunks"."content")) STORED;--> statement-breakpoint
-- Dropping the column dropped this with it. Without recreating it the lexical
-- half of retrieval falls back to a sequential scan: correct results, silently
-- slower, no error — the failure mode this schema keeps warning about.
CREATE INDEX "chunks_content_tsv_idx" ON "chunks" USING gin ("content_tsv");
