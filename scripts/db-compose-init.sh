#!/usr/bin/env bash
# Local Compose bootstrap. Existing databases are never reset or reassigned.
# Privileged work is limited to role/database bootstrap and trusted-extension
# maintenance; numbered migrations run as the same non-bypass owner as CI.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATOR="${DAWAEE_MIGRATOR_ROLE:-dawaee_migrator}"
MIGRATOR_PW="${DAWAEE_MIGRATOR_PASSWORD:-migratorpw}"
if [[ ! "$MIGRATOR" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo 'ERROR: DAWAEE_MIGRATOR_ROLE must be a lowercase Postgres identifier.' >&2
  exit 1
fi

bash "$ROOT/scripts/db-bootstrap-roles.sh" dawaee
psql -v ON_ERROR_STOP=1 -v migrator="$MIGRATOR" -d postgres <<'SQL'
SELECT format('CREATE DATABASE dawaee OWNER %I', :'migrator')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='dawaee')
\gexec
SQL

OWNER="$(psql -v ON_ERROR_STOP=1 -d postgres -tAc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='dawaee'")"
if [ "$OWNER" != "$MIGRATOR" ]; then
  echo "ERROR: existing dawaee database is owned by '$OWNER', not '$MIGRATOR'." >&2
  echo 'Inspect and migrate the existing database explicitly; Compose never resets or takes ownership of it.' >&2
  exit 1
fi

# libpq connection parameters keep passwords out of URLs and shell arguments.
PGUSER="$MIGRATOR" PGPASSWORD="$MIGRATOR_PW" DATABASE_URL='postgresql:///dawaee' \
  bash "$ROOT/scripts/migrate.sh"

# Trusted extension members may remain bootstrap-owned; this is deliberately
# the same privileged post-migration maintenance used by db-reset.sh.
psql -v ON_ERROR_STOP=1 -d dawaee -f "$ROOT/db/maintenance/relocate_extensions.sql"
