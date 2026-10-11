-- GatePass Migration: audit_events baseline (before 0001)
--
-- WHY:
-- No numbered migration ever created the audit_events table or the
-- audit_event_type enum: both came from the initial schema, and every
-- existing database got them from `drizzle-kit push`. 0001 alters
-- audit_events, and 0002 onwards add enum values, so without this file the
-- chain fails on an empty database at 0001.
--
-- SHAPE: the initial commit (553e5be, src/db/schema.ts) before 0001 ran:
-- guard_id is NOT NULL and the enum has only the original 13 values. payload
-- is TEXT NOT NULL with no default: 0001 converts it with ALTER ... TYPE jsonb
-- and Postgres refuses that while a text default is set ("default for column
-- cannot be cast automatically"); 0001 then sets DEFAULT '{}'::jsonb itself.
-- 0001 (payload -> jsonb), the enum migrations 0002-0015, and 0014
-- (resident_id, nullable guard_id) bring it to the current state.
--
-- SAFE ON EXISTING DATABASES: every statement is guarded, so on a database
-- that already has audit_events / audit_event_type (e.g. the live project)
-- this file changes nothing.
--
-- Sorts between 0000 and 0001 under byte order (LC_ALL=C sort).
--
-- ROLLBACK: none needed on existing databases (no-op). On a fresh database,
-- DROP TABLE audit_events; DROP TYPE audit_event_type.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'audit_event_type'
  ) THEN
    CREATE TYPE "public"."audit_event_type" AS ENUM(
      'entry_created',
      'entry_blocked',
      'qr_scan_succeeded',
      'qr_scan_rejected',
      'override_authorized',
      'override_rejected',
      'visitor_selected',
      'visitor_search',
      'batch_sync_completed',
      'override_flow_entered',
      'flow_reset',
      'camera_initialized',
      'camera_failure'
    );
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" "audit_event_type" NOT NULL,
	"guard_id" uuid NOT NULL,
	"trace_id" text NOT NULL,
	"payload" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_guard_id_guards_id_fk" FOREIGN KEY ("guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action
);
