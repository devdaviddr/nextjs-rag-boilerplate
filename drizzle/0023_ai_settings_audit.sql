CREATE TABLE "ai_settings_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"key" text NOT NULL,
	"old_value" text,
	"new_value" text
);
--> statement-breakpoint
ALTER TABLE "ai_settings_audit" ADD CONSTRAINT "ai_settings_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_settings_audit_at_idx" ON "ai_settings_audit" USING btree ("at" DESC NULLS LAST);