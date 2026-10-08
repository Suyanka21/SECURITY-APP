-- GatePass Migration: Resident Portal R3 — household members, workers, vehicles
--
-- Source: src/docs/specs/resident-portal.md §3.4, §11 (owner decisions).
--
-- WHY:
-- A resident registers people and vehicles for their own unit. Each
-- registration is a thin resident-owned row that owns ONE visitor_profiles
-- row and ONE auto_approval_rules row it created, so the existing matching
-- engine keeps doing the matching and the resident can list / remove only
-- what they registered (never staff-created profiles, notes or watch flags).
--
-- visitor_profiles.deleted_by_resident_id (owner-approved): a resident who
-- removes a registration soft-deletes its profile. The soft-delete CHECK is
-- widened from "deleted_by_guard_id set" to "exactly one remover set".
-- Existing rows all satisfy the new CHECK unchanged.
--
-- ROLLBACK:
-- - DROP TABLE unit_registrations.
-- - Verify no visitor_profiles row has deleted_by_resident_id set, restore
--   the previous visitor_profile_soft_delete_consistent CHECK, then drop
--   deleted_by_resident_id.
-- - Enum values cannot be removed in PostgreSQL; they remain unused.

ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'resident_registration_renewed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'resident_registration_blocked';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'resident_registration_block_cleared';--> statement-breakpoint

ALTER TABLE "visitor_profiles" ADD COLUMN IF NOT EXISTS "deleted_by_resident_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "visitor_profiles" ADD CONSTRAINT "visitor_profiles_deleted_by_resident_id_residents_id_fk"
    FOREIGN KEY ("deleted_by_resident_id") REFERENCES "public"."residents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "visitor_profiles" DROP CONSTRAINT IF EXISTS "visitor_profile_soft_delete_consistent";--> statement-breakpoint
ALTER TABLE "visitor_profiles" ADD CONSTRAINT "visitor_profile_soft_delete_consistent" CHECK (
  (("visitor_profiles"."deleted_at" IS NULL) AND ("visitor_profiles"."deleted_by_guard_id" IS NULL) AND ("visitor_profiles"."deleted_by_resident_id" IS NULL))
  OR (("visitor_profiles"."deleted_at" IS NOT NULL) AND (num_nonnulls("visitor_profiles"."deleted_by_guard_id", "visitor_profiles"."deleted_by_resident_id") = 1))
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "unit_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"resident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"plate" text,
	"plate_norm" text GENERATED ALWAYS AS (upper(regexp_replace(coalesce("plate", ''), '[^0-9A-Za-z]', '', 'g'))) STORED NOT NULL,
	"label_norm" text GENERATED ALWAYS AS (lower(regexp_replace(btrim("label"), '\s+', ' ', 'g'))) STORED NOT NULL,
	"visitor_profile_id" uuid NOT NULL,
	"auto_approval_rule_id" uuid NOT NULL,
	"blocked_at" timestamp (3) with time zone,
	"blocked_by_guard_id" uuid,
	"block_reason" text,
	"block_cleared_at" timestamp (3) with time zone,
	"block_cleared_by_guard_id" uuid,
	"block_clear_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "unit_registrations_kind" CHECK ("unit_registrations"."kind" IN ('person', 'vehicle')),
	CONSTRAINT "unit_registrations_label_bounded" CHECK (length(trim("unit_registrations"."label")) BETWEEN 1 AND 60),
	CONSTRAINT "unit_registrations_plate_bounded" CHECK ("unit_registrations"."plate" IS NULL OR length(trim("unit_registrations"."plate")) BETWEEN 1 AND 12),
	CONSTRAINT "unit_registrations_vehicle_has_plate" CHECK ("unit_registrations"."kind" <> 'vehicle' OR "unit_registrations"."plate" IS NOT NULL),
	CONSTRAINT "unit_registrations_block_consistent" CHECK (("unit_registrations"."blocked_at" IS NULL AND "unit_registrations"."blocked_by_guard_id" IS NULL AND "unit_registrations"."block_reason" IS NULL) OR ("unit_registrations"."blocked_at" IS NOT NULL AND "unit_registrations"."blocked_by_guard_id" IS NOT NULL AND ("unit_registrations"."block_reason" IS NULL OR length(trim("unit_registrations"."block_reason")) BETWEEN 1 AND 500))),
	CONSTRAINT "unit_registrations_block_clear_consistent" CHECK (("unit_registrations"."block_cleared_at" IS NULL AND "unit_registrations"."block_cleared_by_guard_id" IS NULL AND "unit_registrations"."block_clear_reason" IS NULL) OR ("unit_registrations"."block_cleared_at" IS NOT NULL AND "unit_registrations"."blocked_at" IS NOT NULL AND "unit_registrations"."block_cleared_by_guard_id" IS NOT NULL AND length(trim("unit_registrations"."block_clear_reason")) BETWEEN 3 AND 500))
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "unit_registrations" ADD CONSTRAINT "unit_registrations_blocked_by_guard_id_guards_id_fk"
    FOREIGN KEY ("blocked_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "unit_registrations" ADD CONSTRAINT "unit_registrations_block_cleared_by_guard_id_guards_id_fk"
    FOREIGN KEY ("block_cleared_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "unit_registrations" ADD CONSTRAINT "unit_registrations_unit_id_units_id_fk"
    FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "unit_registrations" ADD CONSTRAINT "unit_registrations_resident_id_residents_id_fk"
    FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "unit_registrations" ADD CONSTRAINT "unit_registrations_visitor_profile_id_visitor_profiles_id_fk"
    FOREIGN KEY ("visitor_profile_id") REFERENCES "public"."visitor_profiles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "unit_registrations" ADD CONSTRAINT "unit_registrations_rule_fk"
    FOREIGN KEY ("auto_approval_rule_id") REFERENCES "public"."auto_approval_rules"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unit_registrations_resident_idx" ON "unit_registrations" USING btree ("resident_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unit_registrations_rule_idx" ON "unit_registrations" USING btree ("auto_approval_rule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unit_registrations_active_block_idx" ON "unit_registrations" USING btree ("unit_id", "kind") WHERE "unit_registrations"."blocked_at" IS NOT NULL AND "unit_registrations"."block_cleared_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "unit_registrations_active_vehicle_plate_unique" ON "unit_registrations" USING btree ("unit_id", "plate_norm") WHERE "unit_registrations"."kind" = 'vehicle' AND "unit_registrations"."deleted_at" IS NULL;
