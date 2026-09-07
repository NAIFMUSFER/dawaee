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

# Migrations are written to be idempotent, so `IF NOT EXISTS` and
# `DROP ... IF EXISTS` fire a NOTICE on nearly every line of 0008. Several
# hundred of them bury the one message that matters — which migration failed —
# and have trained more than one reader to scroll past a real error. Warnings
# and above still print.
BASE_PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"
export PGOPTIONS="$BASE_PGOPTIONS"

# Managed Postgres can require authenticating as a platform/admin role while
# the application schema is deliberately owned by a separate NOSUPERUSER /
# NOBYPASSRLS role. In that case the connection identity and migration identity
# must remain distinct. MIGRATION_SET_ROLE makes that distinction explicit.
#
# It is opt-in. With the variable unset this script behaves exactly as before.
if [ -n "${MIGRATION_SET_ROLE:-}" ]; then
  if [[ ! "$MIGRATION_SET_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "ERROR: MIGRATION_SET_ROLE must be a lowercase unquoted Postgres identifier." >&2
    exit 1
  fi

  # Check the authenticated role's exact SET capability before changing any
  # session state. This is a read-only capability check and fails closed.
  CAN_SET_ROLE="$(PGOPTIONS="$BASE_PGOPTIONS" PSQLRC=/dev/null psql "$DATABASE_URL" -tAc \
    "SELECT pg_has_role(current_user, '$MIGRATION_SET_ROLE', 'SET')")"
  if [ "$CAN_SET_ROLE" != "t" ]; then
    CONNECTION_ROLE="$(PGOPTIONS="$BASE_PGOPTIONS" PSQLRC=/dev/null psql "$DATABASE_URL" -tAc 'SELECT current_user')"
    echo "ERROR: connection role '$CONNECTION_ROLE' cannot SET ROLE '$MIGRATION_SET_ROLE'." >&2
    exit 1
  fi

  # Supavisor may ignore `role=...` supplied as a startup GUC in PGOPTIONS.
  # psql's startup file is executed after the connection is authenticated and
  # before any -c, -f, or stdin command, so an actual SQL SET ROLE applies to
  # every independent psql session below without changing DATABASE_URL.
  MIGRATION_PSQLRC="$(mktemp)"
  chmod 600 "$MIGRATION_PSQLRC"
  cat > "$MIGRATION_PSQLRC" <<SQL
\\set QUIET 1
SET ROLE $MIGRATION_SET_ROLE;
\\set QUIET 0
SQL
  export PSQLRC="$MIGRATION_PSQLRC"
  trap 'rm -f "$MIGRATION_PSQLRC"' EXIT

  EFFECTIVE_ROLE="$(psql "$DATABASE_URL" -tAc 'SELECT current_user')"
  CONNECTION_ROLE="$(psql "$DATABASE_URL" -tAc 'SELECT session_user')"
  if [ "$EFFECTIVE_ROLE" != "$MIGRATION_SET_ROLE" ]; then
    echo "ERROR: requested migration role '$MIGRATION_SET_ROLE' but effective role is '$EFFECTIVE_ROLE'." >&2
    exit 1
  fi
  echo "preflight: connected as '$CONNECTION_ROLE', assuming migration role '$EFFECTIVE_ROLE'"
fi

# =========================================================== PREFLIGHT
#
# Everything here runs BEFORE the first migration is applied, because the
# alternative was measured and is worse: a deploy that applies 0020 through 0024,
# then discovers at 0025 that it cannot do what it needs, and leaves production
# on a schema no commit corresponds to. Nothing below writes a row of patient
# data; each check either passes or stops the deploy with the schema untouched.
#
# `--preflight-only` runs these and exits, so an operator can answer "would this
# deploy get off the ground?" without starting it. See docs/RUNBOOK-migrate-preflight.md.
PREFLIGHT_ONLY=0
[ "${1:-}" = "--preflight-only" ] && PREFLIGHT_ONLY=1

echo "preflight: connection"
psql "$DATABASE_URL" -tAc 'SELECT 1' > /dev/null

MIGRATION_ROLE="$(psql "$DATABASE_URL" -tAc 'SELECT current_user')"
echo "preflight: migrating as '$MIGRATION_ROLE'"

# 1. The migration role must not be a runtime role.
#
# Running migrations as `dawaee_app` would make the application role the owner
# of every table and every SECURITY DEFINER function, and the definer policies
# below would then hand it a blanket exemption from row-level security on every
# patient table. It would look like a clean deploy.
case "$MIGRATION_ROLE" in
  dawaee_app|dawaee_worker)
    echo "ERROR: migrations must not run as the runtime role '$MIGRATION_ROLE'." >&2
    echo "       DATABASE_URL for migrations must name the schema owner." >&2
    exit 1 ;;
esac

# 2. Role administration, checked before it is needed rather than after.
#
# Since PostgreSQL 16 a CREATEROLE role may only alter roles it created, or ones
# it holds ADMIN OPTION on. If `dawaee_app` and `dawaee_worker` were created by
# a different role — a platform bootstrap, a colleague, an earlier deploy under
# another account — then the role-grant step at the end of this script fails
# with "permission denied to alter role", and by then the migrations have
# already committed. Measured; that is why this check is here and not there.
if [ -n "${DAWAEE_APP_PASSWORD:-}" ] && [ -n "${DAWAEE_WORKER_PASSWORD:-}" ]; then
  BLOCKED="$(psql "$DATABASE_URL" -tAc "
    SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname)
      FROM pg_roles r
     WHERE r.rolname IN ('dawaee_app', 'dawaee_worker')
       AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
       AND NOT EXISTS (
         SELECT 1 FROM pg_auth_members m
          WHERE m.roleid = r.oid
            AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
            AND m.admin_option)")"
  if [ -n "$BLOCKED" ]; then
    cat >&2 <<EOF
ERROR: '$MIGRATION_ROLE' cannot set the password of: $BLOCKED

       Since PostgreSQL 16, changing another role's password requires CREATEROLE
       plus ADMIN OPTION on that role. These roles exist but were created by
       somebody else, so the role-grant step would fail AFTER the migrations had
       committed, leaving the schema half-applied.

       Fix it once, as a role that can, then re-run. INHERIT FALSE / SET FALSE
       grants administration WITHOUT inheriting those roles' privileges or their
       row-level-security policies, which is what you want:
         GRANT dawaee_app    TO $MIGRATION_ROLE WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
         GRANT dawaee_worker TO $MIGRATION_ROLE WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;

       Or unset DAWAEE_APP_PASSWORD and DAWAEE_WORKER_PASSWORD to skip role
       administration entirely and manage those passwords out of band.
EOF
    exit 1
  fi
  echo "preflight: role administration OK"
fi

# 3. The definer privilege path.
#
# Must run before the migration loop: 0025's dedup DELETE on `dose_events`
# depends on it, and a numbered migration cannot fix one that sorts earlier.
# Idempotent, and re-run after the loop for tables this run creates.
echo "preflight: definer policies"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/db/maintenance/definer_policies.sql"

if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
  echo "preflight complete — no migration was applied"
  exit 0
fi

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
# The ledger being PRESENT is not enough to call a database healthy: this
# script creates it before applying anything, so a run that failed on its first
# migration leaves an empty ledger next to a half-applied schema. What marks a
# database as adopted is a ledger with at least one row in it.
# Asked in steps rather than one query: `count(*) FROM schema_migrations`
# fails to parse when the table does not exist, which is exactly the case this
# is trying to detect — and under `set -e` that aborts the deploy instead of
# falling through. `to_regclass` answers safely for a table that may not exist.
if [ "$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" = "t" ]; then
  LEDGER_ROWS="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM schema_migrations')"
else
  LEDGER_ROWS=0
fi
OTHER_TABLES="$(psql "$DATABASE_URL" -tAc "
  SELECT count(*) FROM pg_tables
   WHERE schemaname IN ('public','app') AND tablename <> 'schema_migrations'")"

if [ "${LEDGER_ROWS:-0}" -gt 0 ]; then
  NEEDS_ADOPTION=ledger
elif [ "${OTHER_TABLES:-0}" -eq 0 ]; then
  NEEDS_ADOPTION=empty
else
  NEEDS_ADOPTION=orphan
fi

if [ "$NEEDS_ADOPTION" = "orphan" ]; then
  echo "found schema objects but no migration ledger — checking whether any data exists…"
  ROWS="$(psql "$DATABASE_URL" -tAc "
    SELECT COALESCE(sum(cnt), 0) FROM (
      SELECT (xpath('/row/c/text()',
               query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename),
                            false, true, '')))[1]::text::bigint AS cnt
      FROM pg_tables
      WHERE schemaname IN ('public', 'app') AND tablename <> 'schema_migrations'
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

# The sweep again, for tables this run created. Cheap when there is nothing to
# do, and it means a new FORCE-RLS table is covered on the deploy that adds it
# rather than the one after.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/db/maintenance/definer_policies.sql"

# Role passwords and grants are re-applied every deploy on purpose: they are
# environment state, not schema, and the values live only in the environment.
if [ -n "${DAWAEE_APP_PASSWORD:-}" ] && [ -n "${DAWAEE_WORKER_PASSWORD:-}" ]; then
  echo "applying role grants…"
  DB_NAME="$(psql "$DATABASE_URL" -tAc 'select current_database()')"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
ALTER ROLE dawaee_app    WITH PASSWORD '${DAWAEE_APP_PASSWORD//\'/\'\'}';
ALTER ROLE dawaee_worker WITH PASSWORD '${DAWAEE_WORKER_PASSWORD//\'/\'\'}';
GRANT CONNECT ON DATABASE "$DB_NAME" TO dawaee_app, dawaee_worker;
-- Every patient-facing table is reached through dawaee_app, and row level
-- security is what scopes it, so the API role inherits.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dawaee_app;

-- The WORKER inherits NOTHING. This line used to read
--   GRANT SELECT, INSERT, UPDATE ON TABLES TO dawaee_worker
-- which silently handed the worker three privileges on every table any future
-- migration creates — undoing the whole point of 0021's explicit 22-line
-- manifest, on the one code path that actually runs in production.
-- scripts/db-bootstrap-roles.sh had the REVOKE and migrate.sh had the GRANT;
-- because only bootstrap ran in the test harness and only migrate.sh runs on
-- deploy, the two never disagreed where anyone could see it. Found the moment
-- the harness started using this script. A new worker-visible table now costs
-- one deliberate GRANT in the migration that adds it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM dawaee_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM dawaee_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dawaee_app;
GRANT USAGE ON SCHEMA app TO dawaee_app, dawaee_worker;
SQL
else
  echo "DAWAEE_APP_PASSWORD/DAWAEE_WORKER_PASSWORD unset — skipping role grants"
fi
echo "migrations complete"
