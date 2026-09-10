ALTER TABLE "chunks" ADD COLUMN "kind" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "bbox" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "pages_processed" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extraction" jsonb;