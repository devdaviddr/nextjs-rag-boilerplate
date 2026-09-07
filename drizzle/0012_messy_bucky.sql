-- Spec 0028 — independent knowledge bases.
--
-- drizzle-kit generates `ADD COLUMN ... NOT NULL` for both new columns, which
-- fails outright on any populated database. This file is the hand-staged form:
-- create -> add nullable -> backfill -> ASSERT -> constrain -> index.
--
-- All of it runs inside one transaction (drizzle's migrator wraps each file),
-- so a failed assertion rolls the whole thing back rather than leaving a
-- half-migrated database behind.

CREATE TABLE "knowledge_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_knowledge_bases" (
	"conversation_id" text NOT NULL,
	"knowledge_base_id" text NOT NULL,
	CONSTRAINT "conversation_knowledge_bases_conversation_id_knowledge_base_id_pk" PRIMARY KEY("conversation_id","knowledge_base_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_knowledge_bases" ADD CONSTRAINT "conversation_knowledge_bases_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_knowledge_bases" ADD CONSTRAINT "conversation_knowledge_bases_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Nullable first. A populated table cannot take a NOT NULL column with no
-- default, and there is no sensible default here — the value is per-owner.
ALTER TABLE "documents" ADD COLUMN "knowledge_base_id" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "knowledge_base_id" text;--> statement-breakpoint

-- Backfill. Exactly one KB per owner who ALREADY HAS a document. Users with no
-- documents deliberately get none: the zero-KB empty state is a real state the
-- UI handles, and minting a synthetic default for everyone forever would be
-- worse than handling it.
INSERT INTO "knowledge_bases" ("id", "owner_id", "name", "created_at", "updated_at")
SELECT gen_random_uuid()::text, u."id", 'My documents', now(), now()
FROM "users" u
WHERE EXISTS (SELECT 1 FROM "documents" d WHERE d."owner_id" = u."id");
--> statement-breakpoint
UPDATE "documents" d
SET "knowledge_base_id" = kb."id"
FROM "knowledge_bases" kb
WHERE kb."owner_id" = d."owner_id" AND d."knowledge_base_id" IS NULL;
--> statement-breakpoint
-- Chunks follow their document, never the owner directly — a chunk whose
-- document somehow belongs to a different KB must not be silently re-homed.
UPDATE "chunks" c
SET "knowledge_base_id" = d."knowledge_base_id"
FROM "documents" d
WHERE d."id" = c."document_id" AND c."knowledge_base_id" IS NULL;
--> statement-breakpoint
-- Every pre-existing conversation keeps searching everything it could search
-- before, so nobody's history changes behaviour under them.
INSERT INTO "conversation_knowledge_bases" ("conversation_id", "knowledge_base_id")
SELECT c."id", kb."id"
FROM "conversations" c
JOIN "knowledge_bases" kb ON kb."owner_id" = c."owner_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The one step in this migration where a mistake is silent rather than loud.
-- Grouping the backfill by the wrong key (per document instead of per owner)
-- completes "successfully" and quietly fragments every user's library into
-- singletons, breaking every pre-existing conversation. So it asserts.
DO $$
DECLARE
	fragmented integer;
	orphan_docs integer;
	orphan_chunks integer;
BEGIN
	SELECT count(*) INTO fragmented FROM (
		SELECT "owner_id" FROM "documents"
		GROUP BY "owner_id" HAVING count(DISTINCT "knowledge_base_id") > 1
	) t;
	IF fragmented > 0 THEN
		RAISE EXCEPTION
			'0028 backfill fragmented % owner(s) across multiple knowledge bases', fragmented;
	END IF;

	SELECT count(*) INTO orphan_docs FROM "documents" WHERE "knowledge_base_id" IS NULL;
	IF orphan_docs > 0 THEN
		RAISE EXCEPTION '0028 backfill left % document(s) with no knowledge base', orphan_docs;
	END IF;

	SELECT count(*) INTO orphan_chunks FROM "chunks" WHERE "knowledge_base_id" IS NULL;
	IF orphan_chunks > 0 THEN
		RAISE EXCEPTION '0028 backfill left % chunk(s) with no knowledge base', orphan_chunks;
	END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "documents" ALTER COLUMN "knowledge_base_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "knowledge_base_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "knowledge_bases_owner_id_idx" ON "knowledge_bases" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "conversation_kb_kb_id_idx" ON "conversation_knowledge_bases" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "documents_knowledge_base_id_idx" ON "documents" USING btree ("knowledge_base_id");--> statement-breakpoint
-- Leads with owner_id, so the owner-only queries that used chunks_owner_id_idx
-- keep an index; owner+KB gets the composite. Drop the old one only after the
-- replacement exists.
CREATE INDEX "chunks_owner_kb_idx" ON "chunks" USING btree ("owner_id","knowledge_base_id");--> statement-breakpoint
DROP INDEX IF EXISTS "chunks_owner_id_idx";
