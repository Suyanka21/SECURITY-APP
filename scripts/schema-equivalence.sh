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
#   COMPARE_DB  existing database to diff against instead of building
#             gp_eq_push; it is only dumped, never dropped or modified
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
OTHER_DB="${COMPARE_DB:-$PUSH_DB}"
[ "${COMPARE_DB:-}" != "$SQL_DB" ] || { echo "COMPARE_DB must not be $SQL_DB (it is rebuilt)" >&2; exit 2; }

dbs=("$SQL_DB"); [ -n "${COMPARE_DB:-}" ] || dbs+=("$PUSH_DB")
for db in "${dbs[@]}"; do
  $PSQL "$PSQL_URL/postgres" -X -q -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"
done

echo "### SQL files"
PSQL="$PSQL" scripts/build-db-from-sql.sh "$PSQL_URL/$SQL_DB"

if [ -z "${COMPARE_DB:-}" ]; then
  echo "### drizzle-kit push"
  DATABASE_URL="$PG_URL/$PUSH_DB" npx drizzle-kit push --force | tail -1
fi

dump() {
  $PG_DUMP "$PSQL_URL/$1" --schema-only --no-owner --no-privileges \
    | grep -v -e '^\\restrict' -e '^\\unrestrict'
}
diff -u --label "$OTHER_DB" --label "sql files ($SQL_DB)" \
  <(dump "$OTHER_DB") <(dump "$SQL_DB") > "$OUT" || true
echo "### diff: $(grep -c '^[-+][^-+]' "$OUT" || true) changed lines -> $OUT"
