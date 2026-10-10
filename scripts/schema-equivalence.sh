#!/usr/bin/env bash
# Compare the database built from drizzle/*.sql (scripts/build-db-from-sql.sh)
# with the one `drizzle-kit push` builds from src/db/schema.ts, by diffing
# `pg_dump --schema-only`. CHECK bodies, index definitions and RLS are part of
# the dump, so they are part of the diff. Informational only: exits 0 whatever
# the diff contains (not a CI gate).
#
# Env:
#   PG_URL    server URL reachable from this host, no database
#             (default postgresql://postgres:gp@localhost:54329), used by drizzle-kit
#   PSQL_URL  the same server as seen by $PSQL/$PG_DUMP (default $PG_URL)
#   PSQL, PG_DUMP  clients (default psql, pg_dump), e.g. "docker exec -i gp-pg psql"
#   OUT       diff output path (default ./schema-equivalence.diff)
# The databases gp_eq_sql and gp_eq_push are dropped and recreated.
set -euo pipefail
cd "$(dirname "$0")/.."
PG_URL="${PG_URL:-postgresql://postgres:gp@localhost:54329}"
PSQL_URL="${PSQL_URL:-$PG_URL}"
PSQL="${PSQL:-psql}"
PG_DUMP="${PG_DUMP:-pg_dump}"
OUT="${OUT:-schema-equivalence.diff}"
SQL_DB=gp_eq_sql
PUSH_DB=gp_eq_push

for db in "$SQL_DB" "$PUSH_DB"; do
  $PSQL "$PSQL_URL/postgres" -X -q -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"
done

echo "### SQL files"
PSQL="$PSQL" scripts/build-db-from-sql.sh "$PSQL_URL/$SQL_DB"

echo "### drizzle-kit push"
DATABASE_URL="$PG_URL/$PUSH_DB" npx drizzle-kit push --force | tail -1

dump() {
  $PG_DUMP "$PSQL_URL/$1" --schema-only --no-owner --no-privileges \
    | grep -v -e '^\\restrict' -e '^\\unrestrict'
}
diff -u --label "push ($PUSH_DB)" --label "sql files ($SQL_DB)" \
  <(dump "$PUSH_DB") <(dump "$SQL_DB") > "$OUT" || true
echo "### diff: $(grep -c '^[-+][^-+]' "$OUT" || true) changed lines -> $OUT"
