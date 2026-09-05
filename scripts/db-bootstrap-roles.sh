#!/usr/bin/env bash
# Sets passwords for the application roles and grants them database access.
# Passwords come from the environment and are never written to a file.
set -euo pipefail
DB="${1:-dawaee_dev}"
APP_PW="${DAWAEE_APP_PASSWORD:?DAWAEE_APP_PASSWORD is required}"
WORKER_PW="${DAWAEE_WORKER_PASSWORD:?DAWAEE_WORKER_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<SQL
ALTER ROLE dawaee_app     WITH PASSWORD '$(printf '%s' "$APP_PW" | sed "s/'/''/g")';
ALTER ROLE dawaee_worker  WITH PASSWORD '$(printf '%s' "$WORKER_PW" | sed "s/'/''/g")';
GRANT CONNECT ON DATABASE "$DB" TO dawaee_app, dawaee_worker;
-- Tables created by future migrations inherit the API role's grants: every
-- patient-facing table is reached through dawaee_app, and row level security is
-- what scopes it. A table nobody granted would simply 500 on first use.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dawaee_app;

-- The WORKER inherits nothing. Deliberately: it held SELECT/INSERT/UPDATE on
-- every table including ones it never queries — emergency cards, symptom notes,
-- prescriptions, consents, sessions — because this line used to grant them
-- automatically. A new table becomes reachable by the worker only when someone
-- writes the grant in a migration, against the manifest in
-- 0021_worker_least_privilege.sql. The cost is one deliberate line per new
-- worker table; the alternative is silent re-privilege on every migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM dawaee_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dawaee_app;
GRANT USAGE ON SCHEMA app TO dawaee_app, dawaee_worker;
SQL
echo "roles bootstrapped on $DB"
