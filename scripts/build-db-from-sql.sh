#!/usr/bin/env bash
# Build a database from drizzle/*.sql the way the pilot does (checklist A2):
# every file in byte order (LC_ALL=C, so 0000a_* runs after 0000_* and before
# 0001_* under any locale), each in its own transaction, stopping non-zero on
# the first failing file. Then fail if any public table lacks RLS.
#
# Usage: scripts/build-db-from-sql.sh <database-url>
# PSQL overrides the client, e.g. PSQL="docker exec -i gp-pg psql" (files are
# passed on stdin so a containerised client works).
set -euo pipefail
url="${1:?usage: $0 <database-url>}"
PSQL="${PSQL:-psql}"
cd "$(dirname "$0")/.."

mapfile -t files < <(LC_ALL=C ls drizzle/*.sql | LC_ALL=C sort)
echo "Applying ${#files[@]} files in this order:"
printf '  %s\n' "${files[@]}"
for f in "${files[@]}"; do
  echo "== $f"
  $PSQL "$url" -X -q -v ON_ERROR_STOP=1 -1 -f - < "$f"
done

no_rls=$($PSQL "$url" -X -At -c "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity ORDER BY 1")
echo "== relrowsecurity, every public table"
$PSQL "$url" -X -c "SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1"
if [ -n "$no_rls" ]; then
  echo "FAIL: RLS is disabled on:" >&2
  echo "$no_rls" >&2
  exit 1
fi
echo "OK: RLS enabled on every public table"
