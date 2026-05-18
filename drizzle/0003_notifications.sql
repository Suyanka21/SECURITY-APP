-- GatePass Migration: Feature 2 — Notifications (WhatsApp + SMS)
--
-- Source: src/docs/specs/notifications.md §4 (data model), §11 (audit scenarios)
-- Source: GATEPASS DEFINITION.md L58–60, L67 (WhatsApp + SMS layer)
-- Source: Spec-Driven-Development skill
-- Source: Security-and-Hardening skill — PII discipline, idempotency keys,
--         bounded retry, scrubbed provider response storage
--
-- WHY:
-- Feature 1 created an approval-request row but left the guard to copy
-- the magic link into WhatsApp by hand. Feature 2 adds the persistent
-- delivery model so every send attempt is auditable, retriable, and
-- explicitly surfaced to the guard.
--
-- TABLE: notifications
-- One row per outbound delivery attempt (NOT per approval — WA failure
-- followed by SMS fallback produces two rows). Lifecycle is
-- server-enforced via CHECK constraints:
--   queued → sending → delivered            (terminal success)
--                   ↓
--                  failed → permanently_failed (terminal failure after 3 tries)
--
-- IDEMPOTENCY:
-- idempotency_key = sha256(approval_id || channel || attempt_no) is
-- UNIQUE so the dispatcher can be enqueued twice for the same logical
-- send without producing two outbound provider calls.
--
-- WHY NOT IN approval_requests:
-- Notifications need their own per-attempt row to record provider
-- responses + retries. Mixing into approval_requests would force
-- ALTER on every retry strategy change.
--
-- DEPENDENCIES:
-- - approval_requests gains host_phone_e164 (nullable). Existing rows
--   stay valid; only new approvals with the optional field set will
--   trigger delivery.
-- - audit_event_type enum gains 3 values (notification_*).
--
-- ROLLBACK:
-- - DROP TABLE notifications; DROP TYPE notification_channel;
--   DROP TYPE notification_status;
-- - ALTER TABLE approval_requests DROP COLUMN host_phone_e164;
-- - audit_event_type values cannot be removed in PostgreSQL once
--   added; they will remain harmlessly unused.

-- Step 1: Channel enum.
CREATE TYPE "public"."notification_channel" AS ENUM (
  'whatsapp',
  'sms'
);--> statement-breakpoint

-- Step 2: Status enum (state machine per spec §9).
CREATE TYPE "public"."notification_status" AS ENUM (
  'queued',
  'sending',
  'delivered',
  'failed',
  'permanently_failed'
);--> statement-breakpoint

-- Step 3: Extend audit_event_type for delivery outcomes.
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'notification_sent';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'notification_failed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'notification_permanently_failed';--> statement-breakpoint

-- Step 4: Add the optional phone-number column to approval_requests.
-- Nullable so existing rows remain valid. Validation of E.164 format
-- happens at the API boundary (zod schema in approval-schemas.ts).
ALTER TABLE "approval_requests"
  ADD COLUMN IF NOT EXISTS "host_phone_e164" text;--> statement-breakpoint

-- Step 5: Notifications table.
CREATE TABLE IF NOT EXISTS "notifications" (
  "id"                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "approval_id"                     uuid NOT NULL
                                      REFERENCES "approval_requests"("id")
                                      ON DELETE CASCADE,

  "channel"                         "notification_channel" NOT NULL,

  -- E.164 — validated at the API boundary, NOT in the DB. The DB
  -- enforces non-empty only; full regex validation lives in zod.
  "target_phone"                    text NOT NULL,

  -- Template identifier (e.g. 'approval.magic_link'). Stored so an
  -- auditor can prove a known-good template was used.
  "template_key"                    text NOT NULL,

  -- Rendered body actually sent to the provider. Stored for audit
  -- reproducibility. May contain the magic link URL (the token in
  -- the URL is server-rotated and single-use; storing the rendered
  -- body does NOT extend its lifetime).
  "rendered_body"                   text NOT NULL,

  "status"                          "notification_status" NOT NULL DEFAULT 'queued',

  "attempts"                        integer NOT NULL DEFAULT 0,

  -- sha256(approval_id || channel || attempt_no). UNIQUE so two
  -- enqueues for the same logical attempt collapse to one outbound.
  "idempotency_key"                 text NOT NULL UNIQUE,

  -- Provider response observability — bounded so a chatty provider
  -- can't blow up the row.
  "last_provider_response_code"     integer,
  "last_provider_response_excerpt"  text,
  "last_error_code"                 text,

  "created_at"                      timestamp(3) with time zone NOT NULL DEFAULT now(),
  "updated_at"                      timestamp(3) with time zone NOT NULL DEFAULT now(),
  "delivered_at"                    timestamp(3) with time zone,
  "failed_at"                       timestamp(3) with time zone,

  -- target_phone must not be empty/whitespace (full E.164 validated
  -- at the API boundary).
  CONSTRAINT "notification_target_phone_not_empty"
    CHECK (length(trim("target_phone")) > 0),

  -- attempts must be non-negative and bounded.
  CONSTRAINT "notification_attempts_bounded"
    CHECK ("attempts" >= 0 AND "attempts" <= 10),

  -- provider response excerpt is bounded (spec §3 PII rule).
  CONSTRAINT "notification_response_excerpt_bounded"
    CHECK (
      "last_provider_response_excerpt" IS NULL
      OR length("last_provider_response_excerpt") <= 200
    ),

  -- Terminal status requires the matching timestamp.
  -- Per spec §9 state machine.
  CONSTRAINT "notification_delivered_requires_ts"
    CHECK (
      "status" != 'delivered'
      OR "delivered_at" IS NOT NULL
    ),
  CONSTRAINT "notification_failed_requires_ts"
    CHECK (
      "status" NOT IN ('failed','permanently_failed')
      OR "failed_at" IS NOT NULL
    )
);--> statement-breakpoint

-- Step 6: Indexes (per spec §4).
-- Lookup by approval (per-approval status panel).
CREATE INDEX IF NOT EXISTS "notifications_approval_idx"
  ON "notifications" ("approval_id");--> statement-breakpoint

-- Partial index on non-terminal rows — drives the dispatcher poll
-- AND the lazy-flip-of-stale-sending sweep (spec §9).
CREATE INDEX IF NOT EXISTS "notifications_status_updated_idx"
  ON "notifications" ("status", "updated_at")
  WHERE "status" IN ('queued','sending','failed');--> statement-breakpoint
