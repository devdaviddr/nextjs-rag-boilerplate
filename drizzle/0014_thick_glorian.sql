CREATE TABLE "parsed_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"page" integer NOT NULL,
	"render_scale" real NOT NULL,
	"elements" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "parsed_pages" ADD CONSTRAINT "parsed_pages_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "parsed_pages_file_id_page_idx" ON "parsed_pages" USING btree ("file_id","page");--> statement-breakpoint
CREATE INDEX "documents_status_claimed_at_idx" ON "documents" USING btree ("status","claimed_at");