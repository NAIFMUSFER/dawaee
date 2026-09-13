#!/usr/bin/env bash
# CI-only rehearsal for the exact production ledger after the emergency 0047
# backport: 0001..0033 and 0047 are already applied before audit catch-up.
set -euo pipefail

DB="${1:?unique CI database name required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
MIGRATOR="${DAWAEE_MIGRATOR_ROLE:-dawaee_migrator}"
MIGRATOR_PW="${DAWAEE_MIGRATOR_PASSWORD:-migratorpw}"
export PGHOST PGPORT PGUSER
export DAWAEE_APP_PASSWORD="${DAWAEE_APP_PASSWORD:-devpass}"
export DAWAEE_WORKER_PASSWORD="${DAWAEE_WORKER_PASSWORD:-devpass}"

fail() { echo "HOTFIX UPGRADE REHEARSAL FAIL: $*" >&2; exit 1; }
TMP_ROOT="$(mktemp -d)"
mkdir -p "$TMP_ROOT/scripts" "$TMP_ROOT/db/migrations" "$TMP_ROOT/db/maintenance"
cp "$ROOT/scripts/migrate.sh" "$TMP_ROOT/scripts/migrate.sh"
cp "$ROOT/db/maintenance/definer_policies.sql" "$TMP_ROOT/db/maintenance/definer_policies.sql"

HEAD_COUNT=0
HEAD_LATEST=""
for f in "$ROOT"/db/migrations/*.sql; do
  HEAD_COUNT=$((HEAD_COUNT + 1))
  HEAD_LATEST="$(basename "$f")"
  base="$(basename "$f")"
  num="${base%%_*}"
  if [ $((10#$num)) -le 33 ] || [ $((10#$num)) -eq 47 ]; then
    cp "$f" "$TMP_ROOT/db/migrations/$base"
  fi
done

BASELINE_COUNT="$(find "$TMP_ROOT/db/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')"
[ "$BASELINE_COUNT" = "34" ] || fail "expected 0001..0033 plus 0047, found $BASELINE_COUNT files"

"$ROOT/scripts/db-bootstrap-roles.sh" "$DB" >/dev/null
createdb -O "$MIGRATOR" "$DB"
MIGRATOR_URL="postgres://${MIGRATOR}:${MIGRATOR_PW}@${PGHOST}:${PGPORT}"
export DATABASE_URL="$MIGRATOR_URL/$DB"

bash "$TMP_ROOT/scripts/migrate.sh" >/tmp/dawaee-hotfix-baseline.txt
COUNT="$(psql -d "$DB" -tAc 'SELECT count(*) FROM schema_migrations')"
[ "$COUNT" = "34" ] || fail "hotfix baseline ledger has $COUNT rows, expected 34"
[ "$(psql -d "$DB" -tAc "SELECT count(*) FROM schema_migrations WHERE filename='0047_worker_materialization_privileges.sql'")" = "1" ] || fail "0047 missing from hotfix baseline"
[ "$(psql -d "$DB" -tAc "SELECT count(*) FROM schema_migrations WHERE filename LIKE '0034_%'")" = "0" ] || fail "0034 unexpectedly present in hotfix baseline"

CHECKSUM_BEFORE="$(psql -d "$DB" -tAc "SELECT checksum FROM schema_migrations WHERE filename='0047_worker_materialization_privileges.sql'")"
[ -n "$CHECKSUM_BEFORE" ] || fail "0047 checksum missing before catch-up"

bash "$ROOT/scripts/migrate.sh" | tee /tmp/dawaee-hotfix-catchup.txt
EXPECTED_PENDING=$((HEAD_COUNT - 34))
APPLIED="$(grep -Eo 'applied [0-9]+ migration\(s\)' /tmp/dawaee-hotfix-catchup.txt | tail -1 || true)"
[ "$APPLIED" = "applied $EXPECTED_PENDING migration(s)" ] || fail "expected $EXPECTED_PENDING catch-up migrations, got ${APPLIED:-none}"

COUNT="$(psql -d "$DB" -tAc 'SELECT count(*) FROM schema_migrations')"
LATEST="$(psql -d "$DB" -tAc 'SELECT max(filename) FROM schema_migrations')"
[ "$COUNT" = "$HEAD_COUNT" ] || fail "final ledger has $COUNT rows, expected $HEAD_COUNT"
[ "$LATEST" = "$HEAD_LATEST" ] || fail "final ledger ended at $LATEST, expected $HEAD_LATEST"
[ "$(psql -d "$DB" -tAc "SELECT count(*) FROM schema_migrations WHERE filename='0047_worker_materialization_privileges.sql'")" = "1" ] || fail "0047 replayed or duplicated"
CHECKSUM_AFTER="$(psql -d "$DB" -tAc "SELECT checksum FROM schema_migrations WHERE filename='0047_worker_materialization_privileges.sql'")"
[ "$CHECKSUM_AFTER" = "$CHECKSUM_BEFORE" ] || fail "0047 ledger checksum changed during catch-up"

PRIVS="$(psql -d "$DB" -Atc "SELECT
  has_table_privilege('dawaee_worker','public.dose_occurrences','INSERT')::text || '|' ||
  has_column_privilege('dawaee_worker','public.dose_occurrences','schedule_id','INSERT')::text || '|' ||
  has_column_privilege('dawaee_worker','public.dose_occurrences','confirmed_at','INSERT')::text || '|' ||
  has_table_privilege('dawaee_worker','public.medication_schedules','UPDATE')::text || '|' ||
  has_column_privilege('dawaee_worker','public.medication_schedules','materialized_through','UPDATE')::text || '|' ||
  has_column_privilege('dawaee_worker','public.medication_schedules','rule','UPDATE')::text")"
[ "$PRIVS" = "false|true|false|false|true|false" ] || fail "0047 least-privilege boundary changed after catch-up: $PRIVS"

bash "$ROOT/scripts/migrate.sh" >/tmp/dawaee-hotfix-noop.txt
grep -q 'no pending migrations' /tmp/dawaee-hotfix-noop.txt || fail "second full-head migration run was not a no-op"

echo "PRODUCTION-HOTFIX UPGRADE REHEARSAL PASSED"
echo "baseline          : 0001..0033 + 0047_worker_materialization_privileges.sql"
echo "catch-up          : $EXPECTED_PENDING migration(s), recorded 0047 skipped"
echo "upgraded through  : $HEAD_LATEST"
echo "0047 privileges   : preserved least-privilege boundary"
