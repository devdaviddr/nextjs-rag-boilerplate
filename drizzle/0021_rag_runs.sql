CREATE TABLE "rag_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"conversation_id" text,
	"document_id" text,
	"question" text,
	"mode" text,
	"status" text NOT NULL,
	"termination" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer NOT NULL,
	"ttft_ms" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"best_similarity" real,
	"source_count" integer,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "rag_spans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"key" integer NOT NULL,
	"parent_key" integer,
	"name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"tokens" integer,
	"attributes" jsonb
);
--> statement-breakpoint
ALTER TABLE "rag_spans" ADD CONSTRAINT "rag_spans_run_id_rag_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."rag_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rag_runs_started_idx" ON "rag_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rag_runs_kind_started_idx" ON "rag_runs" USING btree ("kind","started_at");--> statement-breakpoint
CREATE INDEX "rag_spans_run_idx" ON "rag_spans" USING btree ("run_id","key");