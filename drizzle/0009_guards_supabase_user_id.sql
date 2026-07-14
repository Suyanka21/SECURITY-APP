-- GatePass Migration: Phase 2 — link guards to Supabase Auth users
--
-- Source: src/docs/specs/auth-and-role-routing.md §7 (source of truth) and
--         src/docs/adr/0001-auth-role-vs-onboarding-role-and-resident-model.md.
-- Source: src/db/schema.ts §guards.supabaseUserId — the mirrored column.
--
-- WHY THIS EXISTS:
-- Supabase Auth issues the JWT. The verified token's `sub` is the Supabase
-- user UUID (auth.users.id), NOT our guards.id. requireAuth resolves that UUID
-- to a guard row via this column, then requireRole reads guards.role. The role
-- is authoritative from guards.role only — never from the token or Supabase
-- user metadata (ADR 0001).
--
-- NULLABLE: pre-existing guard rows and legacy self-issued-JWT test fixtures
-- (where sub === guards.id) stay valid with no backfill.
--
-- FK GUARD: the reference targets the Supabase-managed `auth.users` table,
-- which only exists in the Supabase database. The DO block adds the FK only
-- where that schema/table is present, so this migration also applies cleanly
-- to a plain local/CI Postgres (integration tests) that has no `auth` schema.
--
-- ROLLBACK:
--   ALTER TABLE "guards" DROP CONSTRAINT IF EXISTS "guards_supabase_user_id_fk";
--   DROP INDEX IF EXISTS "guards_supabase_user_id_unique";
--   ALTER TABLE "guards" DROP COLUMN IF EXISTS "supabase_user_id";

ALTER TABLE "guards" ADD COLUMN IF NOT EXISTS "supabase_user_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "guards_supabase_user_id_unique"
  ON "guards" ("supabase_user_id");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'guards_supabase_user_id_fk'
  ) THEN
    ALTER TABLE "guards"
      ADD CONSTRAINT "guards_supabase_user_id_fk"
      FOREIGN KEY ("supabase_user_id")
      REFERENCES "auth"."users" ("id")
      ON DELETE SET NULL;
  END IF;
END $$;
