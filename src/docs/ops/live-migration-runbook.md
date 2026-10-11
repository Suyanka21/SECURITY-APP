# Live migration runbook: 0014, 0015, 0016 and the pre-R1 reconcile

Applies `drizzle/0014_units_residents.sql`, `drizzle/0015_unit_registrations.sql`,
`drizzle/0016_rls_pre_r1_tables.sql` and `scripts/sql/live-reconcile-pre-r1.sql`
to the live Supabase project `kljrjofhzfbidddxtlkc` (checklist rows A2a, A3).
Do the steps in order and stop at the first one that doesn't give the expected
result. Paste every command's full output into the go-ahead thread.

## 0. Preconditions (all required)

- A **written go-ahead** from the estate's technical owner, naming this runbook.
  The reconcile file needs its own go-ahead line.
- `main` contains the reconcile file with all 11 indexes, and the CI job
  "Test (integration, Postgres)" is green on `main`. Record the commit:
  `git rev-parse HEAD`.
- The R1–R3 server is **not** deployed yet. Every change is additive:
  - new tables, new nullable columns and new enum values;
  - `DROP NOT NULL` on three attribution columns;
  - new CHECKs that existing rows satisfy (section 2, query `r`).

  So the server that is running now keeps working during and after the run.
- psql and pg_dump 17 (`psql --version`), because live runs Postgres 17.6.
- Run it in a quiet period. It takes seconds, but the `ALTER TABLE`s take short
  exclusive locks on `audit_events`, `visitor_profiles`, `auto_approval_rules`,
  `authorization_decisions` and `guards`.

### Connection

Use the **session** pooler (port `5432`) or the direct connection, not the
transaction pooler (port `6543`) that the app's `DATABASE_URL` uses. Copy the
session string from Dashboard → Connect.

```bash
export LIVE_DDL_URL='postgresql://postgres.kljrjofhzfbidddxtlkc:<password>@aws-0-eu-north-1.pooler.supabase.com:5432/postgres'
psql "$LIVE_DDL_URL" -X -Atc "select current_user, inet_server_port(), version()"
# expect: postgres.kljrjofhzfbidddxtlkc-style login resolving to user postgres, PostgreSQL 17.x
```

Before going on, check that the host and user contain `kljrjofhzfbidddxtlkc`.
Never use `uawkuimxaxbhrccfhoag` (see the A1 compromise note).

## 1. Confirm a backup exists

1. Dashboard → Database → Backups. There must be a completed backup from the
   last 24 hours, or a point-in-time-recovery window that covers now. Write
   down its timestamp.
2. Take a logical backup as well, whatever the plan:
   ```bash
   ts=$(date -u +%Y%m%dT%H%M%SZ)
   pg_dump "$LIVE_DDL_URL" -X --schema=public -Fc -f "gatepass-public-pre-0014-$ts.dump"
   pg_restore --list "gatepass-public-pre-0014-$ts.dump" | grep -c 'TABLE DATA public'   # expect 13
   ls -l "gatepass-public-pre-0014-$ts.dump"                                            # non-zero size
   ```
   This file contains personal data (names, phone numbers, plates). Keep it on
   an encrypted disk that only the technical owner can read, and delete it
   under the retention rule in `privacy-data-handling-DRAFT.md`.

Don't go on until both exist.

## 2. Pre-flight (read-only)

```bash
psql "$LIVE_DDL_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SHOW transaction_read_only;                                      -- on
SELECT to_regclass('public.units') AS units, to_regclass('public.unit_registrations') AS unit_registrations;  -- both NULL
SELECT count(*) AS public_tables FROM pg_tables WHERE schemaname='public';   -- 13
-- r: rows the new CHECKs validate: all 0
SELECT count(*) FILTER (WHERE guard_id IS NULL) AS audit_no_guard FROM audit_events;
SELECT count(*) FILTER (WHERE created_by_guard_id IS NULL) AS rules_no_creator FROM auto_approval_rules;
SELECT count(*) FILTER (WHERE created_by_guard_id IS NULL) AS profiles_no_creator FROM visitor_profiles;
-- guards_role_check: 0 rows
SELECT id, role FROM guards WHERE role NOT IN ('guard','senior-guard','admin');
-- unique-index duplicates: 0 rows each
SELECT lower(visitor_name), lower(host), lower(unit), count(*) FROM auto_approval_rules WHERE active = true GROUP BY 1,2,3 HAVING count(*) > 1;
SELECT lower(visitor_name), lower(host), lower(unit), count(*) FROM visitor_profiles WHERE deleted_at IS NULL GROUP BY 1,2,3 HAVING count(*) > 1;
-- privileges 0014 needs for the residents -> auth.users FK: t, t
SELECT has_schema_privilege('auth','USAGE'), has_table_privilege('auth.users','REFERENCES');
ROLLBACK;
SQL
```

Any value other than the one in the comment means stop and report it.

## 3. Apply, one file per transaction

The same command shape for every file:

```bash
apply() {
  psql "$LIVE_DDL_URL" -X -v ON_ERROR_STOP=1 -1 \
    -c "SET LOCAL lock_timeout = '5s'" -c "SET LOCAL statement_timeout = '120s'" \
    -f "$1"
  echo "exit=$?"
}
```

- `-1` wraps the two `SET LOCAL`s and the whole file in one transaction.
- `ON_ERROR_STOP=1` makes psql exit 3 on the first error, which rolls back
  everything in that file.
- The timeouts make a blocked lock fail fast instead of queueing the app's
  traffic behind it.

Run one file, do its checks, then the next. Don't chain them with `&&`.

### 3.1 `0014`

```bash
apply drizzle/0014_units_residents.sql
```

Expected output: `exit=0`, made up of 7 `ALTER TYPE`, 4 `CREATE TABLE`,
6 `CREATE INDEX`, 15 `DO` and 11 `ALTER TABLE`, with no `ERROR`. Then check:

```sql
SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace
  AND relname IN ('units','residents','unit_claim_codes','resident_claim_attempts') ORDER BY 1;  -- 4 rows, all t
SELECT conname FROM pg_constraint WHERE conname IN ('residents_supabase_user_id_auth_users_fk',
  'audit_events_exactly_one_actor','auto_approval_exactly_one_creator','visitor_profile_exactly_one_creator')
  ORDER BY 1;                                                                                    -- 4 rows
SELECT count(*) FROM pg_enum WHERE enumtypid='audit_event_type'::regtype
  AND enumlabel IN ('unit_created','unit_deactivated','unit_claim_code_issued','resident_claimed',
                    'resident_deactivated','resident_registration_created','resident_registration_removed'); -- 7
```

### 3.2 `0015`

```bash
apply drizzle/0015_unit_registrations.sql
```

Expected output: `exit=0`, made up of 3 `ALTER TYPE`, 4 `ALTER TABLE`,
1 `CREATE TABLE`, 7 `DO` and 4 `CREATE INDEX`. Then check:

```sql
SELECT relrowsecurity FROM pg_class WHERE oid='public.unit_registrations'::regclass;   -- t
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='visitor_profile_soft_delete_consistent';
SELECT count(*) FROM pg_enum WHERE enumtypid='audit_event_type'::regtype
  AND enumlabel IN ('resident_registration_renewed','resident_registration_blocked','resident_registration_block_cleared'); -- 3
```

### 3.3 `0016`

```bash
apply drizzle/0016_rls_pre_r1_tables.sql
```

Expected output: `exit=0` and 13 `ALTER TABLE`. This is a no-op on live, which
already has RLS on these tables. Then check:

```sql
SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1;  -- 18 rows, all t
```

### 3.4 Reconcile (separate go-ahead)

```bash
apply scripts/sql/live-reconcile-pre-r1.sql
```

Expected output: `exit=0`, with two `DO` blocks and `CREATE INDEX` lines. The
4 indexes live already has print `already exists, skipping`. Then check:

```sql
SELECT conname, convalidated FROM pg_constraint WHERE conname='guards_role_check';     -- 1 row, t
SELECT c.relname, i.indisvalid, pg_get_expr(i.indpred, i.indrelid) AS where_clause
FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
WHERE c.relname IN ('auto_approval_rules_active_triple_uniq','visitor_profiles_active_triple_uniq',
  'visitor_profiles_watch_idx','exit_records_guard_id_idx','idx_entry_records_delivery',
  'idx_audit_events_payload_gin','visitor_profiles_host_unit_idx','authorization_decisions_pass_ref_idx',
  'guard_notes_entry_id_idx','guard_notes_exit_id_idx','guard_notes_guard_id_idx') ORDER BY 1;
-- 11 rows, all indisvalid t; visitor_profiles_host_unit_idx where_clause (deleted_at IS NULL)
```

## 4. After all files

```bash
psql "$LIVE_DDL_URL" -X -c "SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity"   # 0 rows
curl -s -o /dev/stdout -w '\nHTTP %{http_code}\n' "$SUPABASE_URL/rest/v1/residents?select=*" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
# expect `[]` with HTTP 200 (RLS, no policies), or HTTP 401/403/404. Any row returned: stop, raise as a security incident.
```

Only then deploy the R1–R3 server.

## 5. If a file fails

- **psql prints `ERROR` and `exit=3`.** That file's transaction was rolled
  back, including its `ALTER TYPE … ADD VALUE`s, and nothing from it is
  applied. Don't run the next file.
  1. Save the full output.
  2. Re-run the previous step's checks, or section 2 if `0014` failed, to show
     the database is exactly as before the file.
  3. Report it to the technical owner. Don't edit the file or run its
     statements by hand.
- **`lock_timeout` / `canceling statement due to lock timeout`.** Another
  session held a lock, and the file rolled back as above. See who holds it
  with `SELECT pid, state, query_start, left(query,80) FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid();`, then wait
  for a quieter moment and run the same file again. It is safe to re-run: every
  statement in these files is `IF NOT EXISTS` or guarded.
- **The connection drops in the middle of a file.** The server rolls back the
  open transaction. Reconnect and confirm with section 2's `to_regclass` and
  enum checks whether the file left any trace (it shouldn't). Check
  `pg_stat_activity` for a leftover session from your run, and wait for it to
  end before you re-run the file.
- **A unique index in the reconcile file fails with `could not create unique
  index`.** A duplicate was written after the pre-flight. Re-run the duplicate
  queries from section 2 and settle the rows with the technical owner before
  you try again.
- **A later check fails after the file committed (`exit=0`).** There are no
  down migrations. Stop, keep the old server running, and decide with the
  technical owner between:
  - a reviewed reverse script for that file, or
  - restoring from the step 1 backup (dashboard restore or point-in-time
    recovery, or `pg_restore --clean --if-exists --schema=public` from the
    logical dump).

  Don't improvise DDL on live.

## Rehearsal

This exact sequence ran on local Postgres 17, as a non-superuser owner role.
The database was set up like live:
- `drizzle-kit push` of `schema.ts` at `4e82544`, plus the 4 indexes live has
  from `0011`/`0012`;
- `guards_supabase_user_id_fk` and a stub `auth.users`;
- live's `ensure_rls` event trigger;
- seed rows with mixed-case names.

Every file exited 0, all 18 tables have RLS, and every new constraint and index
was validated against the seeded rows. Repeat it with
`scripts/schema-equivalence.sh` (`COMPARE_DB=`) after any change to these files.
