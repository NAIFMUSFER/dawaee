#!/usr/bin/env bash
# Applies pending migrations, then the role grants.
#
# This runs on EVERY deploy, so "already applied" has to be a normal outcome
# rather than an error. A ledger table records what has run; each file is
# applied at most once, inside a single transaction, and its checksum is
# stored so an edit to a migration that has already shipped is caught here
# instead of becoming a silent difference between two environments.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

applied="$(psql "$DATABASE_URL" -tAF'|' -c 'SELECT filename, checksum FROM schema_migrations')"

pending=0
for f in "$ROOT"/db/migrations/*.sql; do
  base="$(basename "$f")"
  sum="$(md5sum "$f" | cut -d' ' -f1)"
  prior="$(printf '%s\n' "$applied" | awk -F'|' -v n="$base" '$1 == n { print $2 }')"

  if [ -n "$prior" ]; then
    if [ "$prior" != "$sum" ]; then
      echo "ERROR: $base was already applied but its contents have changed." >&2
      echo "       Migrations are immutable once shipped — add a new file instead." >&2
      exit 1
    fi
    continue
  fi

  echo "  applying $base"
  # --single-transaction so a failure part-way leaves nothing behind, and so
  # the ledger row and the migration itself commit together or not at all.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q --single-transaction \
    -f "$f" \
    -c "INSERT INTO schema_migrations (filename, checksum) VALUES ('$base', '$sum')"
  pending=$((pending + 1))
done

if [ "$pending" -eq 0 ]; then
  echo "no pending migrations"
else
  echo "applied $pending migration(s)"
fi

# Role passwords and grants are re-applied every deploy on purpose: they are
# environment state, not schema, and the values live only in the environment.
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
