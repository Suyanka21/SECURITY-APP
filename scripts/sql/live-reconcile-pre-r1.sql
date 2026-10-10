-- GatePass: bring a database built with `drizzle-kit push` before PR #40 in
-- line with drizzle/*.sql (constraints and indexes schema.ts did not declare).
--
-- Found missing on the live project (kljrjofhzfbidddxtlkc) by read-only checks:
--   guards_role_check (0004), auto_approval_rules_active_triple_uniq (0004),
--   visitor_profiles_active_triple_uniq (0005), visitor_profiles_watch_idx (0005),
--   exit_records_guard_id_idx (0007), idx_entry_records_delivery (0008),
--   idx_audit_events_payload_gin (0001); visitor_profiles_host_unit_idx is a
--   full index there instead of partial (0005).
--
-- Not a numbered migration: fresh databases get all of this from drizzle/*.sql.
-- Idempotent: running it twice, or on a SQL-built database, changes nothing.
-- Run as one transaction, ONLY after a written go-ahead:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f scripts/sql/live-reconcile-pre-r1.sql
-- The unique indexes fail to build if duplicate active rows exist; the
-- read-only duplicate checks found none (0 rows in both tables at check time).

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'guards_role_check' AND conrelid = 'public.guards'::regclass
  ) THEN
    ALTER TABLE public.guards
      ADD CONSTRAINT guards_role_check CHECK (role IN ('guard', 'senior-guard', 'admin'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS auto_approval_rules_active_triple_uniq
  ON public.auto_approval_rules (lower(visitor_name), lower(host), lower(unit))
  WHERE active = true;

CREATE UNIQUE INDEX IF NOT EXISTS visitor_profiles_active_triple_uniq
  ON public.visitor_profiles (lower(visitor_name), lower(host), lower(unit))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS visitor_profiles_watch_idx
  ON public.visitor_profiles USING btree (watch_flag)
  WHERE watch_flag = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS exit_records_guard_id_idx
  ON public.exit_records USING btree (guard_id);

CREATE INDEX IF NOT EXISTS idx_entry_records_delivery
  ON public.entry_records (entry_kind, delivery_category)
  WHERE entry_kind = 'delivery';

CREATE INDEX IF NOT EXISTS idx_audit_events_payload_gin
  ON public.audit_events USING gin (payload);

-- visitor_profiles_host_unit_idx: replace the full index with the partial one,
-- only if the existing index has no WHERE clause.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'visitor_profiles_host_unit_idx'
      AND c.relnamespace = 'public'::regnamespace
      AND i.indpred IS NULL
  ) THEN
    DROP INDEX public.visitor_profiles_host_unit_idx;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS visitor_profiles_host_unit_idx
  ON public.visitor_profiles USING btree (host, unit)
  WHERE deleted_at IS NULL;
