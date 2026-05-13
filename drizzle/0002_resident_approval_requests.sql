-- GatePass Migration: Feature 1 — Resident approval flow
--
-- Source: src/docs/specs/resident-approval-flow.md §7–§9
-- Source: GATEPASS DEFINITION.md §USER FLOW.2.B — "request approval"
-- Source: Spec-Driven-Development skill — "spec gates implementation"
-- Source: Security-and-Hardening skill — magic-link tokens, hashed at rest,
--         single-use, short-lived
--
-- WHY:
-- The walk-in flow has no mechanism for the resident to authorize an unrecognized
-- visitor. Today the only paths are:
--   (a) walk-in: guard accepts on the resident's behalf with no audit trail
--   (b) override: guard takes responsibility with a reason
-- Both are unsafe defaults for a security app. Feature 1 introduces an explicit
-- "wait for the resident to decide" path: the guard requests approval, a magic
-- link goes to the resident, the resident approves or denies in <30s, and the
-- entry record is created transactionally inside the approve handler.
--
-- TABLE: approval_requests
-- One row per resident-decision request. Lifecycle is server-enforced:
--   pending → approved | denied | expired
-- Each terminal status is required to carry the audit trail (entry_id for
-- approved, denied_reason for denied, decided_at for any decision).
--
-- SECURITY:
-- - 32 random bytes generated server-side, shown to resident ONCE in the URL.
-- - Only SHA-256(token) is stored (token_hash). Raw token never persists.
-- - token_hash is set NULL after a successful decision → strictly single-use.
-- - status + expires_at let the server lazily flip stale `pending` rows to
--   `expired` on every read, so clients cannot observe a stale pending row past
--   the deadline.
--
-- DEPENDENCIES:
-- - audit_event_type enum gains four new values (approval_*). The enum is
--   altered, not recreated; existing values are preserved.
-- - approval_requests.requested_by_guard_id → guards(id) — set from JWT only.
-- - approval_requests.entry_id → entry_records(id) — populated transactionally
--   on approve.
--
-- ROLLBACK:
-- - DROP TABLE approval_requests; DROP TYPE approval_status;
-- - The audit_event_type values cannot be removed in PostgreSQL once added;
--   they will remain harmlessly unused if the table is rolled back.

-- Step 1: New enum for approval lifecycle status.
CREATE TYPE "public"."approval_status" AS ENUM (
  'pending',
  'approved',
  'denied',
  'expired'
);--> statement-breakpoint

-- Step 2: Extend the audit_event_type enum.
-- ALTER TYPE ADD VALUE is non-destructive and additive; existing rows keep
-- their values. IF NOT EXISTS makes the migration safe to re-run.
-- Source: https://www.postgresql.org/docs/current/sql-altertype.html
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'approval_requested';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'approval_approved';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'approval_denied';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'approval_expired';--> statement-breakpoint

-- Step 3: Create the approval_requests table.
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offline_id" uuid NOT NULL,
	"visitor_name" text NOT NULL,
	"host" text NOT NULL,
	"unit" text NOT NULL,
	"plate" text,
	"reason" text DEFAULT '' NOT NULL,
	"method" "entry_method" NOT NULL,
	"requested_by_guard_id" uuid NOT NULL,
	"token_hash" text,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp (3) with time zone,
	"denied_reason" text,
	"entry_id" uuid,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"trace_id" text NOT NULL,
	CONSTRAINT "approval_requests_offline_id_unique" UNIQUE("offline_id"),
	CONSTRAINT "approval_requests_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "approval_visitor_name_not_empty" CHECK (length(trim("approval_requests"."visitor_name")) > 0),
	CONSTRAINT "approval_host_not_empty" CHECK (length(trim("approval_requests"."host")) > 0),
	CONSTRAINT "approval_unit_not_empty" CHECK (length(trim("approval_requests"."unit")) > 0),
	CONSTRAINT "approval_approved_requires_entry" CHECK ("approval_requests"."status" != 'approved' OR "approval_requests"."entry_id" IS NOT NULL),
	CONSTRAINT "approval_denied_requires_reason" CHECK ("approval_requests"."status" != 'denied' OR "approval_requests"."denied_reason" IS NOT NULL),
	CONSTRAINT "approval_terminal_requires_decided_at" CHECK ("approval_requests"."status" = 'pending' OR "approval_requests"."decided_at" IS NOT NULL)
);--> statement-breakpoint

-- Step 4: Foreign keys.
-- ON DELETE no action preserves the audit trail; we never cascade away a guard
-- or an entry record. If a guard is deactivated, their historical approvals
-- remain visible for shift-log queries (Feature 5).
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_guard_id_guards_id_fk" FOREIGN KEY ("requested_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_entry_id_entry_records_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Step 5: Indexes.
-- (status, expires_at) supports the expiry sweep:
--   SELECT id FROM approval_requests WHERE status = 'pending' AND expires_at < now();
-- (requested_by_guard_id) supports "my pending approvals" for the guard UI
-- and shift-log aggregations.
CREATE INDEX "approval_requests_status_expires_at_idx" ON "approval_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "approval_requests_requested_by_guard_id_idx" ON "approval_requests" USING btree ("requested_by_guard_id");

-- NOTE: This migration does NOT (re-)create the audit_events table. That table
-- already exists in production; the drizzle snapshot at idx=0 predates it, so
-- drizzle-kit emits a spurious CREATE TABLE diff. We strip it here. The
-- audit_events shape is otherwise unchanged.
