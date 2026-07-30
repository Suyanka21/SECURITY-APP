-- GatePass Migration: Feature 9 (Stage 2) — Guard Notes
--
-- Source: src/docs/specs/guard-notes.md §§3–5
--
-- WHY:
-- Guards need to attach standardised, reportable context to an entry/exit
-- record (e.g. "Left ID at gate") without free-typing arbitrary strings.
-- This migration adds a `guard_note_tag` enum (standardised, aggregatable)
-- and a `guard_notes` table that links a note to exactly one entry OR exit.
--
-- HARD RULES (DB-enforced):
-- - A note attaches to exactly one target: entry XOR exit (CHECK).
-- - Every note is attributed to a guard (guard_id NOT NULL + FK).
-- - `tag` is a standardised enum — never a raw string.
-- - Free text is allowed ONLY for tag='other', is required there, and is
--   capped at 280 chars after trim; non-'other' tags carry no free text (CHECK).
-- - No CASCADE deletes — the audit trail must never lose a note.
--
-- AUDIT extension:
-- audit_event_type gains `guard_note_added`, written on every successful note.
-- ALTER TYPE ADD VALUE is non-destructive and idempotent via IF NOT EXISTS.
--
-- DEPENDENCIES:
-- - entry_records, exit_records, guards tables (FKs).
--
-- ROLLBACK:
-- - DROP TABLE guard_notes; DROP TYPE guard_note_tag;
-- - The audit_event_type value cannot be removed once added in PostgreSQL;
--   it remains harmlessly unused if rolled back.

-- Step 1: Extend the audit_event_type enum.
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'guard_note_added';--> statement-breakpoint

-- Step 2: Create the standardised guard-note tag enum.
DO $$ BEGIN
	CREATE TYPE "public"."guard_note_tag" AS ENUM ('delivered_parcel', 'left_id_at_gate', 'escorted_by_resident', 'other');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Step 3: Create the guard_notes table.
CREATE TABLE IF NOT EXISTS "guard_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid,
	"exit_id" uuid,
	"guard_id" uuid NOT NULL,
	"tag" "guard_note_tag" NOT NULL,
	"note_text" text,
	"trace_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guard_note_target_xor" CHECK (("guard_notes"."entry_id" IS NOT NULL AND "guard_notes"."exit_id" IS NULL) OR ("guard_notes"."entry_id" IS NULL AND "guard_notes"."exit_id" IS NOT NULL)),
	CONSTRAINT "guard_note_text_coherence" CHECK (("guard_notes"."tag" = 'other' AND "guard_notes"."note_text" IS NOT NULL AND length(trim("guard_notes"."note_text")) BETWEEN 1 AND 280) OR ("guard_notes"."tag" != 'other' AND "guard_notes"."note_text" IS NULL))
);--> statement-breakpoint

-- Step 4: Foreign keys (no CASCADE — audit trail preserved).
-- Guarded with duplicate_object so re-application is a safe no-op.
DO $$ BEGIN
	ALTER TABLE "guard_notes" ADD CONSTRAINT "guard_notes_entry_id_entry_records_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_records"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "guard_notes" ADD CONSTRAINT "guard_notes_exit_id_exit_records_id_fk" FOREIGN KEY ("exit_id") REFERENCES "public"."exit_records"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "guard_notes" ADD CONSTRAINT "guard_notes_guard_id_guards_id_fk" FOREIGN KEY ("guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Step 5: Indices for common query paths (list notes per entry/exit, per guard).
CREATE INDEX IF NOT EXISTS "guard_notes_entry_id_idx" ON "guard_notes" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guard_notes_exit_id_idx" ON "guard_notes" USING btree ("exit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guard_notes_guard_id_idx" ON "guard_notes" USING btree ("guard_id");
