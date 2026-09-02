#!/usr/bin/env bash
# Drop and rebuild a database from db/migrations. Development / CI only.
set -euo pipefail
DB="${1:-dawaee_dev}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
export PGHOST PGPORT PGUSER
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

psql -q -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null
psql -q -d postgres -c "CREATE DATABASE \"$DB\"" >/dev/null
for f in "$ROOT"/db/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
  echo "  applied $(basename "$f")"
done
echo "database $DB rebuilt"
