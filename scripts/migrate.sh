#!/usr/bin/env bash
# Applies migrations, then the role grants. Idempotent: every migration is
# written to converge, so re-running a deploy is safe.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "applying migrations…"
for f in "$ROOT"/db/migrations/*.sql; do
  echo "  $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

if [ -n "${DAWAEE_APP_PASSWORD:-}" ] && [ -n "${DAWAEE_WORKER_PASSWORD:-}" ]; then
  echo "applying role grants…"
  DB_NAME="$(psql "$DATABASE_URL" -tAc 'select current_database()')"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
ALTER ROLE dawaee_app    WITH PASSWORD '${DAWAEE_APP_PASSWORD//\'/\'\'}';
ALTER ROLE dawaee_worker WITH PASSWORD '${DAWAEE_WORKER_PASSWORD//\'/\'\'}';
GRANT CONNECT ON DATABASE "$DB_NAME" TO dawaee_app, dawaee_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dawaee_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO dawaee_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dawaee_app, dawaee_worker;
SQL
else
  echo "DAWAEE_APP_PASSWORD/DAWAEE_WORKER_PASSWORD unset — skipping role grants"
fi
echo "migrations complete"
