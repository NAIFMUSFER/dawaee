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

# ---------------------------------------------------------------- adoption
#
# A database can carry schema objects with no ledger only one way: a migration
# run that predates the ledger, which by definition ended in failure part-way
# through (a successful one would have created the ledger). Such a database is
# in an unknown state — some files applied, one applied halfway — and the
# migrations are not written to be re-runnable, so continuing would fail on the
# first `CREATE TYPE` and keep failing on every deploy after.
#
# The guard is what makes clearing it safe: this fires ONLY when the ledger is
# absent AND every table present is empty. A database anyone has actually used
# has either a ledger or rows, so it takes the refusal path instead and a human
# decides. Once a deploy succeeds the ledger exists and this can never run again.
NEEDS_ADOPTION="$(psql "$DATABASE_URL" -tAc "
  SELECT CASE
    WHEN to_regclass('public.schema_migrations') IS NOT NULL THEN 'ledger'
    WHEN NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public','app')) THEN 'empty'
    ELSE 'orphan'
  END")"

if [ "$NEEDS_ADOPTION" = "orphan" ]; then
  echo "found schema objects but no migration ledger — checking whether any data exists…"
  ROWS="$(psql "$DATABASE_URL" -tAc "
    SELECT COALESCE(sum(cnt), 0) FROM (
      SELECT (xpath('/row/c/text()',
               query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename),
                            false, true, '')))[1]::text::bigint AS cnt
      FROM pg_tables WHERE schemaname IN ('public', 'app')
    ) t")"

  if [ "${ROWS:-0}" -gt 0 ]; then
    echo "ERROR: this database has $ROWS row(s) but no migration ledger." >&2
    echo "       That combination cannot be resolved automatically without risking data." >&2
    echo "       Inspect it, then either back it up and drop the schema, or backfill" >&2
    echo "       schema_migrations with the files already applied." >&2
    exit 1
  fi

  echo "no data present — clearing the partial schema so migrations can apply cleanly"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA IF EXISTS app CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
SQL
fi

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
