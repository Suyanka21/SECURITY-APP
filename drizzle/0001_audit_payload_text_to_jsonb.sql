-- GatePass Migration: audit_events.payload TEXT → JSONB
--
-- Source: TRUSTLESS-AUDIT-REPORT-v2 [M3] — "Audit payload stored as text"
-- Source: Deprecation-and-Migration skill — "Build the replacement, migrate incrementally"
--
-- WHY:
-- - TEXT requires JSON.parse() on every query and prevents JSON operators
-- - JSONB enables native ->, ->>, @>, and GIN index support
-- - JSONB validates JSON structure at INSERT time (DB-level enforcement)
--
-- SAFETY:
-- - All existing payload values are valid JSON (produced by JSON.stringify)
-- - USING payload::jsonb safely converts existing TEXT data
-- - NOT NULL + DEFAULT '{}' preserved
-- - This is an ALTER (non-destructive), not a DROP+CREATE
--
-- ROLLBACK: ALTER TABLE audit_events ALTER COLUMN payload TYPE text USING payload::text;

-- Step 1: Convert column from TEXT to JSONB with backfill
ALTER TABLE audit_events
  ALTER COLUMN payload TYPE jsonb
  USING payload::jsonb;

-- Step 2: Update default value to JSONB literal
ALTER TABLE audit_events
  ALTER COLUMN payload SET DEFAULT '{}'::jsonb;

-- Step 3 (optional): Add GIN index for efficient JSONB queries
-- Enables: WHERE payload @> '{"method": "override"}'
CREATE INDEX IF NOT EXISTS idx_audit_events_payload_gin
  ON audit_events USING GIN (payload);

-- Verification queries (run manually to confirm migration):
-- SELECT payload->>'entryId' FROM audit_events WHERE event_type = 'entry_created' LIMIT 5;
-- SELECT count(*) FROM audit_events WHERE payload @> '{"method": "override"}';
