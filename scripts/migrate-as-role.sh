#!/usr/bin/env bash
# Connect with the environment's administrative DATABASE_URL, then narrow the
# effective role used by every psql process spawned by migrate.sh. This exists
# for managed Postgres environments where the connection role (for example
# `postgres` behind a pooler) is not the owner of the application schema.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
ROLE="${MIGRATION_SET_ROLE:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# No role requested: preserve the historical behaviour exactly.
if [ -z "$ROLE" ]; then
  exec bash "$ROOT/scripts/migrate.sh" "$@"
fi

# The role name is interpolated into one SQL literal and one PGOPTIONS value.
# Restrict it to ordinary unquoted Postgres identifiers so neither surface can
# become an option/SQL injection path through deployment configuration.
if [[ ! "$ROLE" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "ERROR: MIGRATION_SET_ROLE must be a lowercase unquoted Postgres identifier." >&2
  exit 1
fi

BASE_PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"

# Check the privilege before changing the effective role. pg_has_role(...,
# 'SET') answers the exact capability needed for SET ROLE and does not grant or
# mutate anything.
CAN_SET="$(PGOPTIONS="$BASE_PGOPTIONS" psql "$DATABASE_URL" -tAc \
  "SELECT pg_has_role(current_user, '$ROLE', 'SET')")"
if [ "$CAN_SET" != "t" ]; then
  SESSION_ROLE="$(PGOPTIONS="$BASE_PGOPTIONS" psql "$DATABASE_URL" -tAc 'SELECT current_user')"
  echo "ERROR: connection role '$SESSION_ROLE' cannot SET ROLE '$ROLE'." >&2
  exit 1
fi

# libpq passes PGOPTIONS to every new Postgres session. Setting the `role` GUC
# here is equivalent to SET ROLE at connection start, so all independent psql
# invocations inside migrate.sh see the same effective owner role while
# session_user remains the authenticated connection role.
export PGOPTIONS="$BASE_PGOPTIONS -c role=$ROLE"

EFFECTIVE_ROLE="$(psql "$DATABASE_URL" -tAc 'SELECT current_user')"
SESSION_ROLE="$(psql "$DATABASE_URL" -tAc 'SELECT session_user')"
if [ "$EFFECTIVE_ROLE" != "$ROLE" ]; then
  echo "ERROR: requested migration role '$ROLE' but effective role is '$EFFECTIVE_ROLE'." >&2
  exit 1
fi

echo "preflight: connected as '$SESSION_ROLE', assuming migration role '$EFFECTIVE_ROLE'"
exec bash "$ROOT/scripts/migrate.sh" "$@"
