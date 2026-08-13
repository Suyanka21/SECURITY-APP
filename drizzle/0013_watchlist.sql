-- GatePass Migration: Feature 12 (Stage 5) — Watchlist
--
-- Source: src/docs/specs/watchlist.md §§2, 6, 7
--
-- WHY:
-- Admins/senior-guards flag a subject with a MANDATORY reason. At entry the
-- guard sees a warning carrying that reason and must escalate to a supervisor.
-- The system NEVER auto-denies — this table only ever produces a warning.
--
-- REVIEW MODEL (spec §7, Option 2 — accepted before implementation):
-- Entries do not expire on their own. `review_due_at` (= last_reviewed_at +
-- 90 days) makes a row OVERDUE, which is derived at read time and only changes
-- how admins see it — the row keeps warning guards until a human removes it
-- with a reason. No background sweep exists to silently fail, and there is no
-- stored 'expired' status that could drift out of sync with the clock.
--
-- HARD RULES (DB-enforced):
-- - reason is NOT NULL and must be non-blank, 1..500 chars.
-- - status is a closed set: 'active' | 'removed' (no 'expired').
-- - Removal coherence: a removed row MUST carry who removed it and why; an
--   active row must carry neither (no half-removed row that still matches).
-- - No CASCADE deletes — the audit trail must never lose a watchlist history.
--
-- AUDIT extension:
-- audit_event_type gains 'watchlist_entry_added', 'watchlist_matched',
-- 'watchlist_entry_reviewed', 'watchlist_entry_removed'.
-- ALTER TYPE ADD VALUE is non-destructive and idempotent via IF NOT EXISTS.
--
-- DEPENDENCIES:
-- - guards table (added_by_guard_id / removed_by_guard_id).
--
-- ROLLBACK:
-- - DROP TABLE watchlist_entries;
-- - The audit_event_type values cannot be removed once added in PostgreSQL;
--   they remain harmlessly unused if rolled back.

-- Step 1: Extend the audit_event_type enum (additive, idempotent).
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'watchlist_entry_added';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'watchlist_matched';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'watchlist_entry_reviewed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'watchlist_entry_removed';--> statement-breakpoint

-- Step 2: The watchlist table.
CREATE TABLE IF NOT EXISTS "watchlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_name" text NOT NULL,
	"subject_name_display" text NOT NULL,
	"subject_plate" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"added_by_guard_id" uuid NOT NULL,
	"last_reviewed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"review_due_at" timestamp (3) with time zone NOT NULL,
	"removed_by_guard_id" uuid,
	"removed_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_reason_not_blank" CHECK (length(trim("watchlist_entries"."reason")) BETWEEN 1 AND 500),
	CONSTRAINT "watchlist_status_valid" CHECK ("watchlist_entries"."status" IN ('active', 'removed')),
	CONSTRAINT "watchlist_removal_coherence" CHECK (("watchlist_entries"."status" = 'removed' AND "watchlist_entries"."removed_by_guard_id" IS NOT NULL AND "watchlist_entries"."removed_reason" IS NOT NULL AND length(trim("watchlist_entries"."removed_reason")) BETWEEN 1 AND 500) OR ("watchlist_entries"."status" = 'active' AND "watchlist_entries"."removed_by_guard_id" IS NULL AND "watchlist_entries"."removed_reason" IS NULL))
);--> statement-breakpoint

-- Step 3: Foreign keys (guarded so a re-run is a no-op).
DO $$ BEGIN
	ALTER TABLE "watchlist_entries" ADD CONSTRAINT "watchlist_entries_added_by_guard_id_guards_id_fk" FOREIGN KEY ("added_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "watchlist_entries" ADD CONSTRAINT "watchlist_entries_removed_by_guard_id_guards_id_fk" FOREIGN KEY ("removed_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Step 4: Lookup indexes — name/plate are the entry-time match path,
-- (status, review_due_at) serves the admin "needs review" query.
CREATE INDEX IF NOT EXISTS "watchlist_entries_subject_name_idx" ON "watchlist_entries" USING btree ("subject_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watchlist_entries_subject_plate_idx" ON "watchlist_entries" USING btree ("subject_plate");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watchlist_entries_review_idx" ON "watchlist_entries" USING btree ("status","review_due_at");
