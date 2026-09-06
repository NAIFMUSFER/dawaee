#!/usr/bin/env bash
# Rebuild a database from db/migrations. Development / CI only.
#
# THE TOPOLOGY, AND WHY IT CHANGED
#
# This script used to create the database as the superuser it connected with,
# so `dawaee_test` was owned by `postgres`. Under FORCE ROW LEVEL SECURITY the
# owner is only exempt if it is a superuser or holds BYPASSRLS — and `postgres`
# is both. Every `app.*` SECURITY DEFINER function therefore ran with an
# unconditional bypass that the deployment target does not have, and the entire
# integration suite proved its properties against the wrong configuration.
# Registration was broken on a realistic managed Postgres while 1013 tests
# passed. (P18.)
#
# The database is now created OWNED BY a role that is deliberately NOSUPERUSER
# and NOBYPASSRLS, and migrations are applied through the real deploy script as
# that role. Tests exercise the same privilege model production runs on.
#
# The privileged connection ($PGUSER, normally `postgres`) is used only to
# create roles and to create/drop databases.
set -euo pipefail
DB="${1:-dawaee_dev}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
export PGHOST PGPORT PGUSER
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MIGRATOR="${DAWAEE_MIGRATOR_ROLE:-dawaee_migrator}"
MIGRATOR_PW="${DAWAEE_MIGRATOR_PASSWORD:-migratorpw}"
export DAWAEE_APP_PASSWORD="${DAWAEE_APP_PASSWORD:-devpass}"
export DAWAEE_WORKER_PASSWORD="${DAWAEE_WORKER_PASSWORD:-devpass}"

"$ROOT/scripts/db-bootstrap-roles.sh" "$DB" > /dev/null

MIGRATOR_URL="postgres://${MIGRATOR}:${MIGRATOR_PW}@${PGHOST}:${PGPORT}"

# ------------------------------------------------------------- template
#
# Nineteen test files rebuild this database, and applying thirty migrations each
# time is thirty psql round trips each time. A template database is built once
# per distinct migration set and copied per reset, which is one operation.
#
# The fingerprint covers every migration AND the definer-policy sweep, so a
# change to either invalidates the template rather than leaving suites running
# against a schema that no longer matches the tree.
FINGERPRINT="$(cat "$ROOT"/db/migrations/*.sql "$ROOT"/db/maintenance/definer_policies.sql | md5sum | cut -d' ' -f1)"
TEMPLATE="${DB}_tmpl"

template_ok() {
  [ "$(psql -tAc "SELECT count(*) FROM pg_database WHERE datname = '$TEMPLATE'")" = "1" ] || return 1
  [ "$(psql -tAc "SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '$TEMPLATE'")" = "$FINGERPRINT" ]
}

if ! template_ok; then
  psql -q -c "DROP DATABASE IF EXISTS \"$TEMPLATE\" WITH (FORCE)" -d postgres > /dev/null
  psql -q -c "CREATE DATABASE \"$TEMPLATE\" OWNER $MIGRATOR" -d postgres > /dev/null
  DATABASE_URL="$MIGRATOR_URL/$TEMPLATE" "$ROOT/scripts/migrate.sh" > /dev/null
  # Stamped only after a clean apply, so a failed build is never reused.
  psql -q -d postgres -c "COMMENT ON DATABASE \"$TEMPLATE\" IS '$FINGERPRINT'" > /dev/null
  echo "  built template $TEMPLATE"
fi

psql -q -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" > /dev/null
psql -q -d postgres -c "CREATE DATABASE \"$DB\" TEMPLATE \"$TEMPLATE\" OWNER $MIGRATOR" > /dev/null
# Database-level ACLs are not carried by TEMPLATE — they live on the pg_database
# row, not inside it — so CONNECT is granted again here.
psql -q -d postgres -c "GRANT CONNECT ON DATABASE \"$DB\" TO dawaee_app, dawaee_worker, $MIGRATOR" > /dev/null

echo "database $DB rebuilt (owner $MIGRATOR, NOSUPERUSER NOBYPASSRLS)"
