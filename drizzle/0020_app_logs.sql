CREATE TABLE "app_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"time" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"request_id" text,
	"user_id" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE INDEX "app_logs_time_idx" ON "app_logs" USING btree ("time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_logs_request_idx" ON "app_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "app_logs_level_time_idx" ON "app_logs" USING btree ("level","time");