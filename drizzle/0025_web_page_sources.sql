ALTER TABLE "documents" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "fetched_at" timestamp with time zone;