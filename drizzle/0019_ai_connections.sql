CREATE TABLE "ai_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"preset" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_ciphertext" text,
	"api_key_hint" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_connections" ADD CONSTRAINT "ai_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;