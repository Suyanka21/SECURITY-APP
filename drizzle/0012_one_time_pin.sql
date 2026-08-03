-- GatePass Migration: Feature 11 (Stage 4) — One-Time PIN Backup
--
-- Source: src/docs/specs/one-time-pin-backup.md §§4–6
--
-- WHY:
-- A 6-digit PIN is issued alongside every QR pass as an alternate way to
-- redeem the SAME authorization_decisions record. Redeeming by QR or PIN
-- flips the existing is_used flag, so either method invalidates both. A
-- per-pass limiter locks the pass after repeated wrong PINs.
--
-- HARD RULES:
-- - The raw PIN is NEVER stored — only HMAC(PIN_PEPPER, "<id>:<pin>").
-- - pass_ref is a short, NON-secret identifier (like a ticket number),
--   UNIQUE so a guard can address exactly one pass.
-- - All columns are nullable / defaulted so rows issued before this
--   feature remain valid (they simply have no PIN).
--
-- AUDIT extension:
-- audit_event_type gains 'pin_redeemed', 'pin_failed', 'pin_locked'.
-- ALTER TYPE ADD VALUE is non-destructive and idempotent via IF NOT EXISTS.
--
-- DEPENDENCIES:
-- - authorization_decisions table (Feature 6).
--
-- ROLLBACK:
-- - ALTER TABLE authorization_decisions DROP COLUMN pass_ref, pin_hash,
--   pin_failed_attempts, pin_locked_until;
-- - The audit_event_type values cannot be removed once added in PostgreSQL;
--   they remain harmlessly unused if rolled back.

-- Step 1: Extend the audit_event_type enum (additive, idempotent).
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'pin_redeemed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'pin_failed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'pin_locked';--> statement-breakpoint

-- Step 2: Add the PIN-backup columns to authorization_decisions.
ALTER TABLE "authorization_decisions" ADD COLUMN IF NOT EXISTS "pass_ref" text;--> statement-breakpoint
ALTER TABLE "authorization_decisions" ADD COLUMN IF NOT EXISTS "pin_hash" text;--> statement-breakpoint
ALTER TABLE "authorization_decisions" ADD COLUMN IF NOT EXISTS "pin_failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "authorization_decisions" ADD COLUMN IF NOT EXISTS "pin_locked_until" timestamp (3) with time zone;--> statement-breakpoint

-- Step 3: Unique constraint on pass_ref (multiple NULLs allowed in Postgres,
-- so legacy rows without a pass_ref do not collide).
DO $$ BEGIN
	ALTER TABLE "authorization_decisions" ADD CONSTRAINT "authorization_decisions_pass_ref_unique" UNIQUE ("pass_ref");
EXCEPTION
	WHEN duplicate_object THEN null;
	WHEN duplicate_table THEN null;
END $$;--> statement-breakpoint

-- Step 4: Index the lookup path (redeem is keyed on pass_ref).
CREATE INDEX IF NOT EXISTS "authorization_decisions_pass_ref_idx" ON "authorization_decisions" USING btree ("pass_ref");
