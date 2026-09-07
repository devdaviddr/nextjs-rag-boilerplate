ALTER TABLE "chunks" ADD COLUMN "heading" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "content_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "chunks"."content")) STORED;--> statement-breakpoint
CREATE INDEX "chunks_content_tsv_idx" ON "chunks" USING gin ("content_tsv");