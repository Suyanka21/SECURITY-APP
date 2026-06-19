-- GatePass Migration: Feature 7 — Exit Tracking
--
-- Source: src/docs/specs/exit-tracking.md §5 (data model)
--
-- WHY:
-- Today every entry is write-once with no exit event. This migration
-- adds an exit_records table that closes the entry-to-exit lifecycle.
-- Each exit is linked 1:1 to an entry via a UNIQUE FK on entry_id.
-- The exit guard may differ from the entry guard — that's by design.
--
-- HARD RULES (DB-enforced):
-- - One exit per entry (UNIQUE on entry_id).
-- - Every exit attributed to a guard (guard_id NOT NULL + FK).
-- - Every exit carries a trace_id for audit correlation.
-- - No CASCADE deletes — audit trail must never lose records.
--
-- AUDIT extensions:
-- audit_event_type enum gains two new values:
--   exit_recorded  — successful exit
--   exit_blocked   — rejected exit (no open entry, already exited)
-- ALTER TYPE ADD VALUE is non-destructive and idempotent via IF NOT EXISTS.
--
-- DEPENDENCIES:
-- - entry_records table (FK on entry_id)
-- - guards table (FK on guard_id)
--
-- ROLLBACK:
-- - DROP TABLE exit_records;
-- - The two audit_event_type values cannot be removed once added in
--   PostgreSQL. They remain harmlessly unused if rolled back.

-- Step 1: Extend the audit_event_type enum.
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'exit_recorded';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'exit_blocked';--> statement-breakpoint

-- Step 2: Create the exit_records table.
CREATE TABLE "exit_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL UNIQUE,
	"guard_id" uuid NOT NULL,
	"trace_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Step 3: Foreign keys.
ALTER TABLE "exit_records" ADD CONSTRAINT "exit_records_entry_id_entry_records_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_records" ADD CONSTRAINT "exit_records_guard_id_guards_id_fk" FOREIGN KEY ("guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Step 4: Indices for common query paths.
-- On-premise query (LEFT JOIN exclusion on entry_id):
CREATE INDEX "exit_records_entry_id_idx" ON "exit_records" USING btree ("entry_id");--> statement-breakpoint
-- Guard attribution:
CREATE INDEX "exit_records_guard_id_idx" ON "exit_records" USING btree ("guard_id");
