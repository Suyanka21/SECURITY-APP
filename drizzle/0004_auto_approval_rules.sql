-- GatePass Migration: Feature 3 — Auto-approval engine
--
-- Source: src/docs/specs/auto-approval.md §3 (data model), §4 (match algorithm)
-- Source: GATEPASS DEFINITION.md L18 ("Pre-approved frequent visitors should
--         not need re-approval every time")
-- Source: Security-and-Hardening skill — default-deny, kill-switch, TTL
-- Source: Spec-Driven-Development skill
--
-- WHY:
-- Feature 1 wired a manual approval path. Feature 3 adds a bounded,
-- default-deny rule evaluator that can short-circuit the approval to
-- 'approved' synchronously when (visitor_name, host, unit) — and the
-- optional plate pin — match an active, non-expired rule. Every other
-- code path (no rule, expired rule, deactivated rule, plate mismatch,
-- evaluator exception) falls through to the manual flow unchanged.
--
-- TABLE: auto_approval_rules
-- One row per pre-approval. Lifecycle:
--   created (active=true)
--    ├── matched many times (last_matched_at + match_count updated)
--    ├── deactivated (active=false, kill switch)
--    └── expired lazily on evaluator read (expires_at <= now)
--
-- Lookups are case-insensitive on the triple. The functional partial
-- UNIQUE index below enforces "one ACTIVE rule per identity triple" at
-- the database level — never trust the application alone.
--
-- AUDIT extensions:
-- audit_event_type enum gains four new values (auto_approval_*). The
-- ALTER TYPE ADD VALUE statements are non-destructive; existing rows
-- keep their values. IF NOT EXISTS makes the migration safe to re-run.
--
-- ENTRY METHOD extension:
-- entry_method enum gains 'auto' — written ONLY when an auto-approval
-- short-circuits and the entry is created. The frontend reducer treats
-- 'auto' identically to 'walk-in' for counter purposes, but the UI shows
-- a visible "auto" pill so guards can tell at a glance.
--
-- DEPENDENCIES:
-- - guards table (FK created_by_guard_id → guards.id)
-- - audit_events table (new event types only, no schema change)
--
-- ROLLBACK:
-- - DROP TABLE auto_approval_rules;
-- - The four audit_event_type values and the 'auto' entry_method value
--   cannot be removed once added in PostgreSQL. They remain harmlessly
--   unused if the table is rolled back.

-- Step 1: Extend the entry_method enum with 'auto'.
-- ALTER TYPE ADD VALUE is non-destructive; existing rows keep their
-- values. IF NOT EXISTS makes the migration safe to re-run.
-- Source: https://www.postgresql.org/docs/current/sql-altertype.html
ALTER TYPE "public"."entry_method" ADD VALUE IF NOT EXISTS 'auto';--> statement-breakpoint

-- Step 2: Extend the audit_event_type enum with the four new events.
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'auto_approval_rule_created';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'auto_approval_rule_deactivated';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'auto_approval_rule_expired';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'auto_approval_matched';--> statement-breakpoint

-- Step 3: Create the auto_approval_rules table.
CREATE TABLE "auto_approval_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visitor_name" text NOT NULL,
	"host" text NOT NULL,
	"unit" text NOT NULL,
	"plate_required" text,
	"created_by_guard_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_matched_at" timestamp (3) with time zone,
	"match_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "auto_approval_visitor_name_not_empty" CHECK (length(trim("auto_approval_rules"."visitor_name")) BETWEEN 1 AND 120),
	CONSTRAINT "auto_approval_host_bounded" CHECK (length(trim("auto_approval_rules"."host")) BETWEEN 1 AND 120),
	CONSTRAINT "auto_approval_unit_bounded" CHECK (length(trim("auto_approval_rules"."unit")) BETWEEN 1 AND 32),
	CONSTRAINT "auto_approval_plate_bounded" CHECK ("auto_approval_rules"."plate_required" IS NULL OR length(trim("auto_approval_rules"."plate_required")) BETWEEN 1 AND 32),
	CONSTRAINT "auto_approval_positive_ttl" CHECK ("auto_approval_rules"."expires_at" > "auto_approval_rules"."created_at")
);--> statement-breakpoint

-- Step 4: Foreign keys.
-- ON DELETE no action preserves the audit trail; we never cascade away a guard.
ALTER TABLE "auto_approval_rules" ADD CONSTRAINT "auto_approval_rules_created_by_guard_id_guards_id_fk" FOREIGN KEY ("created_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Step 5: Indices.
-- Lookup index used by the evaluator on every approval-create path.
CREATE INDEX "auto_approval_rules_triple_idx" ON "auto_approval_rules" USING btree ("visitor_name","host","unit");--> statement-breakpoint
-- Admin attribution queries (e.g. "show all rules guard X created").
CREATE INDEX "auto_approval_rules_guard_idx" ON "auto_approval_rules" USING btree ("created_by_guard_id");--> statement-breakpoint

-- Step 6: Functional partial UNIQUE index — "one ACTIVE rule per triple".
-- Drizzle's unique() helper cannot express functional indices, so this
-- runs as raw SQL. The lower() expressions make the constraint
-- case-insensitive without needing a generated column.
CREATE UNIQUE INDEX "auto_approval_rules_active_triple_uniq" ON "auto_approval_rules" (lower("visitor_name"), lower("host"), lower("unit")) WHERE "active" = true;--> statement-breakpoint

-- Step 7: Role column on guards table.
--
-- Source: src/docs/specs/auto-approval.md §8 (security).
-- Auto-approval rule seed/list/deactivate endpoints require an admin
-- role. The default value 'guard' keeps existing rows valid; admins
-- must be promoted explicitly. The CHECK enforces the closed set of
-- allowed values at the DB layer (never trust application alone).
--
-- This is additive: any code that doesn't read the column continues
-- to work. The auth middleware reads it via getActiveGuard().
ALTER TABLE "guards" ADD COLUMN "role" text NOT NULL DEFAULT 'guard';--> statement-breakpoint
ALTER TABLE "guards" ADD CONSTRAINT "guards_role_check" CHECK ("role" IN ('guard', 'senior-guard', 'admin'));
