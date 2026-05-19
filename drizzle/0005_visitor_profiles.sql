-- GatePass Migration: Feature 4 — Visitor Profile CRUD
--
-- Source: src/docs/specs/visitor-profiles.md §2 (data model)
-- Source: GATEPASS DEFINITION.md §6 (visitor profile CRUD listed as out
--         of scope of PR #1 — Feature 4 territory).
-- Source: Security-and-Hardening skill — soft-delete + audit trail.
-- Source: API-and-Interface-Design skill — bounded fields + UNIQUE
--         constraint at the database layer (never trust application).
--
-- WHY:
-- Today "visitors" are read-only and derived from entry history. This
-- migration creates a first-class visitor_profiles table that augments
-- (never silently overrides) the algorithmic recognition tag with:
--   - a phone_e164 column the notification path can read (E.164 format)
--   - a watch_flag column for visitors that need extra scrutiny
--   - free-form notes (bounded to 1000 chars after trim)
--   - soft-delete via (deleted_at, deleted_by_guard_id) with a CHECK
--     enforcing both columns are either set together or both NULL.
--
-- HARD RULES (DB-enforced, never trust the application alone):
-- - One ACTIVE profile per (lower(name), lower(host), lower(unit)).
--   Soft-deleted rows DO NOT block re-adding the same identity (the
--   partial UNIQUE index excludes deleted rows).
-- - All bounded text fields enforce length(trim(...)) BETWEEN bounds.
-- - phone_e164 is NULL or matches '^\+[1-9]\d{1,14}$' (E.164).
-- - Soft-delete consistency: (deleted_at IS NULL) = (deleted_by_guard_id IS NULL).
--
-- AUDIT extensions:
-- audit_event_type enum gains four new values. ALTER TYPE ADD VALUE is
-- non-destructive; existing rows keep their values. IF NOT EXISTS makes
-- the migration safe to re-run.
--
-- DEPENDENCIES:
-- - guards table (FK on created_by_guard_id + deleted_by_guard_id)
-- - audit_events table (new event types only, no schema change)
-- - Feature 3 migration 0004 introduced the role column + requireRole
--   middleware reused by the routes.
--
-- ROLLBACK:
-- - DROP TABLE visitor_profiles;
-- - The four audit_event_type values cannot be removed once added in
--   PostgreSQL. They remain harmlessly unused if rolled back.

-- Step 1: Extend the audit_event_type enum.
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'visitor_profile_created';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'visitor_profile_updated';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'visitor_profile_soft_deleted';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'visitor_profile_restored';--> statement-breakpoint

-- Step 2: Create the visitor_profiles table.
CREATE TABLE "visitor_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visitor_name" text NOT NULL,
	"host" text NOT NULL,
	"unit" text NOT NULL,
	"plate" text,
	"phone_e164" text,
	"notes" text,
	"watch_flag" boolean DEFAULT false NOT NULL,
	"created_by_guard_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by_guard_id" uuid,
	CONSTRAINT "visitor_profile_name_bounded" CHECK (length(trim("visitor_profiles"."visitor_name")) BETWEEN 1 AND 120),
	CONSTRAINT "visitor_profile_host_bounded" CHECK (length(trim("visitor_profiles"."host")) BETWEEN 1 AND 120),
	CONSTRAINT "visitor_profile_unit_bounded" CHECK (length(trim("visitor_profiles"."unit")) BETWEEN 1 AND 32),
	CONSTRAINT "visitor_profile_plate_bounded" CHECK ("visitor_profiles"."plate" IS NULL OR length(trim("visitor_profiles"."plate")) BETWEEN 1 AND 32),
	CONSTRAINT "visitor_profile_phone_e164_format" CHECK ("visitor_profiles"."phone_e164" IS NULL OR "visitor_profiles"."phone_e164" ~ '^\+[1-9]\d{1,14}$'),
	CONSTRAINT "visitor_profile_notes_bounded" CHECK ("visitor_profiles"."notes" IS NULL OR length(trim("visitor_profiles"."notes")) BETWEEN 1 AND 1000),
	CONSTRAINT "visitor_profile_soft_delete_consistent" CHECK ((("visitor_profiles"."deleted_at" IS NULL) AND ("visitor_profiles"."deleted_by_guard_id" IS NULL)) OR (("visitor_profiles"."deleted_at" IS NOT NULL) AND ("visitor_profiles"."deleted_by_guard_id" IS NOT NULL)))
);--> statement-breakpoint

-- Step 3: Foreign keys.
-- ON DELETE no action preserves the audit trail; we never cascade away a guard.
ALTER TABLE "visitor_profiles" ADD CONSTRAINT "visitor_profiles_created_by_guard_id_guards_id_fk" FOREIGN KEY ("created_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_profiles" ADD CONSTRAINT "visitor_profiles_deleted_by_guard_id_guards_id_fk" FOREIGN KEY ("deleted_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Step 4: Indices for common query paths.
-- Resident-scoped listings ("show me profiles for unit 18B"):
CREATE INDEX "visitor_profiles_host_unit_idx" ON "visitor_profiles" USING btree ("host","unit") WHERE "deleted_at" IS NULL;--> statement-breakpoint
-- Watch-list lookup ("show me everyone flagged"):
CREATE INDEX "visitor_profiles_watch_idx" ON "visitor_profiles" USING btree ("watch_flag") WHERE "watch_flag" = true AND "deleted_at" IS NULL;--> statement-breakpoint
-- Creator attribution:
CREATE INDEX "visitor_profiles_creator_idx" ON "visitor_profiles" USING btree ("created_by_guard_id");--> statement-breakpoint

-- Step 5: Functional partial UNIQUE index — "one ACTIVE profile per
-- identity triple". Drizzle's unique() helper cannot express functional
-- indices, so this runs as raw SQL. The lower() expressions make the
-- constraint case-insensitive without needing a generated column.
-- The `WHERE "deleted_at" IS NULL` clause excludes soft-deleted rows —
-- a previously-deleted profile does NOT block re-creating the same
-- identity (spec §2).
CREATE UNIQUE INDEX "visitor_profiles_active_triple_uniq" ON "visitor_profiles" (lower("visitor_name"), lower("host"), lower("unit")) WHERE "deleted_at" IS NULL;
