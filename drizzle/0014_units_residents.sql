-- GatePass Migration: Resident Portal R1 — units, residents, claim codes
--
-- Source: src/docs/specs/resident-portal.md §2 (data model), §3.1 (auth),
--         §3.5 (audit), §10 decisions 2, 4, 6.
--
-- WHY:
-- Residents become self-serve, phone-OTP-authenticated actors scoped to
-- exactly ONE unit. A resident is NOT a row in `guards` — `requireRole`
-- reads guards.role, and a resident row there would put every staff
-- authorisation check one typo away from a resident. Residents get their
-- own table and their own middleware (requireResidentAuth).
--
-- LINKAGE MODEL (spec §2.3, decision 2 — claim code, not admin-typed phone):
-- An admin issues a one-shot code for a unit. The resident signs in with
-- phone OTP and redeems the code once; the residents row is created in the
-- SAME transaction that marks the code used. The DB stores only the HMAC
-- of the code (peppered with PIN_PEPPER, like one-time PINs).
--
-- EXACTLY-ONE-UNIT is structural: at most one ACTIVE residents row per
-- supabase_user_id (partial unique index) + unit_id NOT NULL, and no
-- application path updates unit_id. Moving units = deactivate + redeem a new
-- code, which inserts a NEW row (history keeps pointing at the old unit).
--
-- ATTRIBUTION (spec §2.5, approved): visitor_profiles and
-- auto_approval_rules gain a nullable created_by_resident_id; the existing
-- created_by_guard_id is relaxed to nullable; a CHECK requires EXACTLY ONE
-- of the two. authorization_decisions gains issued_by_resident_id (nullable;
-- guard-issued passes keep issuer identity in the audit row as today).
--
-- AUDIT (spec §3.5): audit_events.guard_id is relaxed to nullable and a
-- resident_id column is added with a CHECK that exactly one actor is set.
-- Every existing row keeps its guard_id; the append-only rule is untouched.
--
-- ROLLBACK:
-- - DROP TABLE resident_claim_attempts, unit_claim_codes, residents, units
--   (in that order); drop the *_resident_id columns and restore NOT NULL on
--   created_by_guard_id / guard_id after verifying no resident rows exist.
-- - Enum values cannot be removed in PostgreSQL; they remain unused.

-- Step 1: Audit enum values (additive, idempotent).
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'unit_created';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'unit_deactivated';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'unit_claim_code_issued';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'resident_claimed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'resident_deactivated';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'resident_registration_created';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'resident_registration_removed';--> statement-breakpoint

-- Step 2: units — the canonical source of the text `unit` label used by
-- authorization_decisions / visitor_profiles / auto_approval_rules.
CREATE TABLE IF NOT EXISTS "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"label_norm" text GENERATED ALWAYS AS (lower(trim("label"))) STORED NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_guard_id" uuid NOT NULL,
	"deactivated_at" timestamp (3) with time zone,
	"deactivated_by_guard_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_label_bounded" CHECK (length(trim("units"."label")) BETWEEN 1 AND 32),
	CONSTRAINT "units_deactivation_consistent" CHECK (("units"."is_active" = true AND "units"."deactivated_at" IS NULL AND "units"."deactivated_by_guard_id" IS NULL) OR ("units"."is_active" = false AND "units"."deactivated_at" IS NOT NULL AND "units"."deactivated_by_guard_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "units_label_norm_unique" ON "units" ("label_norm");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "units" ADD CONSTRAINT "units_created_by_guard_id_guards_id_fk" FOREIGN KEY ("created_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "units" ADD CONSTRAINT "units_deactivated_by_guard_id_guards_id_fk" FOREIGN KEY ("deactivated_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Step 3: residents — one row per (Supabase user, unit) membership; at most one active.
CREATE TABLE IF NOT EXISTS "residents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supabase_user_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"phone_e164" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"claimed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp (3) with time zone,
	"deactivated_by_guard_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "residents_name_bounded" CHECK (length(trim("residents"."display_name")) BETWEEN 1 AND 120),
	CONSTRAINT "residents_phone_e164_format" CHECK ("residents"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "residents_deactivation_consistent" CHECK (("residents"."is_active" = true AND "residents"."deactivated_at" IS NULL AND "residents"."deactivated_by_guard_id" IS NULL) OR ("residents"."is_active" = false AND "residents"."deactivated_at" IS NOT NULL AND "residents"."deactivated_by_guard_id" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "residents_unit_idx" ON "residents" ("unit_id");--> statement-breakpoint
-- One row per (user, unit) membership: moving units deactivates the old row
-- and the next claim inserts a new one, so historical references (used claim
-- codes, audit_events.resident_id, resident-created rows) keep resolving to
-- the unit they were made for. At most ONE active row per user and per phone.
CREATE INDEX IF NOT EXISTS "residents_supabase_user_idx" ON "residents" ("supabase_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "residents_active_user_unique" ON "residents" ("supabase_user_id") WHERE "residents"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "residents_active_phone_unique" ON "residents" ("phone_e164") WHERE "residents"."is_active" = true;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "residents" ADD CONSTRAINT "residents_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "residents" ADD CONSTRAINT "residents_deactivated_by_guard_id_guards_id_fk" FOREIGN KEY ("deactivated_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
-- Cross-schema FK to Supabase auth.users, guarded like migration 0009 so the
-- migration also applies on a plain Postgres without the auth schema.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users') THEN
  ALTER TABLE "residents" ADD CONSTRAINT "residents_supabase_user_id_auth_users_fk" FOREIGN KEY ("supabase_user_id") REFERENCES auth.users(id) ON DELETE no action ON UPDATE no action;
 END IF;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Step 4: unit_claim_codes — admin-issued, one-shot, hashed at rest.
CREATE TABLE IF NOT EXISTS "unit_claim_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"issued_by_guard_id" uuid NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"used_by_resident_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_claim_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "unit_claim_codes_used_consistent" CHECK (("unit_claim_codes"."used_at" IS NULL) = ("unit_claim_codes"."used_by_resident_id" IS NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unit_claim_codes_unit_idx" ON "unit_claim_codes" ("unit_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unit_claim_codes" ADD CONSTRAINT "unit_claim_codes_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unit_claim_codes" ADD CONSTRAINT "unit_claim_codes_issued_by_guard_id_guards_id_fk" FOREIGN KEY ("issued_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unit_claim_codes" ADD CONSTRAINT "unit_claim_codes_used_by_resident_id_residents_id_fk" FOREIGN KEY ("used_by_resident_id") REFERENCES "public"."residents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Step 5: resident_claim_attempts — per-Supabase-user lockout for wrong
-- codes. A wrong code cannot be attributed to any code row, so the counter
-- lives on the CALLER (5 failures → 15-minute lock), mirroring the PIN
-- lockout's fail-closed shape.
CREATE TABLE IF NOT EXISTS "resident_claim_attempts" (
	"supabase_user_id" uuid PRIMARY KEY NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp (3) with time zone,
	"last_failed_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Step 6: attribution on existing matching tables (spec §2.5, approved).
ALTER TABLE "visitor_profiles" ALTER COLUMN "created_by_guard_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "visitor_profiles" ADD COLUMN IF NOT EXISTS "created_by_resident_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visitor_profiles" ADD CONSTRAINT "visitor_profiles_created_by_resident_id_residents_id_fk" FOREIGN KEY ("created_by_resident_id") REFERENCES "public"."residents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visitor_profiles" ADD CONSTRAINT "visitor_profile_exactly_one_creator" CHECK (num_nonnulls("created_by_guard_id", "created_by_resident_id") = 1);
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

ALTER TABLE "auto_approval_rules" ALTER COLUMN "created_by_guard_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_approval_rules" ADD COLUMN IF NOT EXISTS "created_by_resident_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auto_approval_rules" ADD CONSTRAINT "auto_approval_rules_created_by_resident_id_residents_id_fk" FOREIGN KEY ("created_by_resident_id") REFERENCES "public"."residents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auto_approval_rules" ADD CONSTRAINT "auto_approval_exactly_one_creator" CHECK (num_nonnulls("created_by_guard_id", "created_by_resident_id") = 1);
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

ALTER TABLE "authorization_decisions" ADD COLUMN IF NOT EXISTS "issued_by_resident_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "authorization_decisions" ADD CONSTRAINT "authorization_decisions_issued_by_resident_id_residents_id_fk" FOREIGN KEY ("issued_by_resident_id") REFERENCES "public"."residents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Step 7: audit actor — a resident action must be attributable without a
-- guard id. Exactly one actor per row.
ALTER TABLE "audit_events" ALTER COLUMN "guard_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "resident_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_exactly_one_actor" CHECK (num_nonnulls("guard_id", "resident_id") = 1);
EXCEPTION WHEN duplicate_object THEN null; END $$;
