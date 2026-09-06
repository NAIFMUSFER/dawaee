#!/usr/bin/env bash
# Privileged bootstrap. Development and CI only — production never runs this.
#
# WHAT CHANGED AND WHY
#
# This used to be a grant script run as a superuser against a superuser-owned
# database. That is what hid the defect P18 found: with a superuser owner, every
# SECURITY DEFINER function bypasses row-level security unconditionally, so the
# whole test suite proved its properties against a configuration the deployment
# target does not have. Registration was broken on a realistic managed Postgres
# and 1013 passing tests said nothing about it.
#
# So the privileged connection is now used for exactly three things a
# non-superuser cannot do for itself:
#
#   1. create the three roles with the right attributes,
#   2. give the migration role ADMIN OPTION on the two runtime roles, because
#      PostgreSQL 16 needs it to set their passwords,
#   3. set the passwords the first time.
#
# Everything after that — schema, grants, default privileges, definer policies —
# runs as `dawaee_migrator`, which is deliberately NOSUPERUSER and NOBYPASSRLS.
#
# Passwords come from the environment and are never written to a file.
set -euo pipefail
DB="${1:-dawaee_dev}"
APP_PW="${DAWAEE_APP_PASSWORD:?DAWAEE_APP_PASSWORD is required}"
WORKER_PW="${DAWAEE_WORKER_PASSWORD:?DAWAEE_WORKER_PASSWORD is required}"
MIGRATOR_PW="${DAWAEE_MIGRATOR_PASSWORD:-migratorpw}"
MIGRATOR="${DAWAEE_MIGRATOR_ROLE:-dawaee_migrator}"

q() { printf '%s' "$1" | sed "s/'/''/g"; }

psql -v ON_ERROR_STOP=1 -d postgres >/dev/null <<SQL
DO \$\$
BEGIN
  -- The migration owner. CREATEDB and CREATEROLE so it can build its own test
  -- databases and create the two runtime roles from migration 0008; explicitly
  -- NOSUPERUSER and NOBYPASSRLS so it is subject to FORCE ROW LEVEL SECURITY
  -- exactly as the deployment target's role is.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$(q "$MIGRATOR")') THEN
    CREATE ROLE $MIGRATOR LOGIN CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dawaee_app') THEN
    CREATE ROLE dawaee_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dawaee_worker') THEN
    CREATE ROLE dawaee_worker LOGIN;
  END IF;
END \$\$;

ALTER ROLE $MIGRATOR      WITH NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE LOGIN PASSWORD '$(q "$MIGRATOR_PW")';
ALTER ROLE dawaee_app     WITH PASSWORD '$(q "$APP_PW")';
ALTER ROLE dawaee_worker  WITH PASSWORD '$(q "$WORKER_PW")';

-- PostgreSQL 16 onwards: a CREATEROLE role may only alter roles it created or
-- holds ADMIN OPTION on. migrate.sh sets both runtime passwords on every
-- deploy, so without this it fails — and it used to fail AFTER the migrations
-- had committed. The direction matters and is asserted in 0030: the migrator
-- may administer the runtime roles; a runtime role must never be able to
-- SET ROLE into the migrator.
-- INHERIT FALSE, SET FALSE (PostgreSQL 16+): administration WITHOUT inheritance.
-- A plain WITH ADMIN OPTION also makes the migrator inherit both roles'
-- privileges AND their row-level-security policies, which quietly changes what
-- a SECURITY DEFINER function can see and makes the test topology less like
-- production, not more. Measured: with plain membership the negative control
-- for a missing definer policy stopped firing, because the owner was reading
-- dose_events through dawaee_worker's own policy instead.
GRANT dawaee_app    TO $MIGRATOR WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT dawaee_worker TO $MIGRATOR WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;

-- The property the whole test topology rests on. If someone "helpfully" makes
-- the migrator a superuser to get past an error, every RLS test silently stops
-- proving anything, so refuse loudly here rather than pass quietly later.
DO \$\$
DECLARE r record;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = '$(q "$MIGRATOR")';
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION 'the migration role % must be NOSUPERUSER and NOBYPASSRLS (super=%, bypassrls=%)',
      '$(q "$MIGRATOR")', r.rolsuper, r.rolbypassrls;
  END IF;
  SELECT bool_or(rolsuper), bool_or(rolbypassrls) INTO r
    FROM pg_roles WHERE rolname IN ('dawaee_app', 'dawaee_worker');
  IF r.bool_or OR r.bool_or THEN
    RAISE EXCEPTION 'a runtime role can bypass row-level security';
  END IF;
END \$\$;
SQL

# CONNECT is per-database and the database may not exist yet when this is used
# as a pure role bootstrap, so it is best effort here; migrate.sh grants it
# authoritatively as the database owner.
psql -v ON_ERROR_STOP=1 -d postgres -q \
  -c "GRANT CONNECT ON DATABASE \"$DB\" TO dawaee_app, dawaee_worker, $MIGRATOR" 2>/dev/null || true

echo "roles bootstrapped ($MIGRATOR owns migrations; app/worker are plain LOGIN roles)"
