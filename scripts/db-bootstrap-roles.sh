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
-- Tables created by future migrations inherit the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dawaee_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO dawaee_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dawaee_app, dawaee_worker;
SQL
echo "roles bootstrapped on $DB"
