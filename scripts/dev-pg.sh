#!/usr/bin/env bash
# Starts the local development Postgres if it is not already accepting
# connections. The sandbox reaps idle background processes, so this is safe to
# call before any task that touches the database.
set -uo pipefail
export PATH=$PATH:/usr/lib/postgresql/16/bin
if psql -h 127.0.0.1 -p 5433 -U postgres -tAc 'select 1' >/dev/null 2>&1; then
  echo "postgres already up"; exit 0
fi
mkdir -p /tmp/pgdata /tmp/pgrun
chown -R claude:claude /tmp/pgdata /tmp/pgrun 2>/dev/null || true
if [ ! -f /tmp/pgdata/PG_VERSION ]; then
  su claude -c "PATH=$PATH initdb -D /tmp/pgdata -U postgres --auth=trust -E UTF8 --locale=C" >/tmp/initdb.log 2>&1
fi
su claude -c "PATH=$PATH pg_ctl -D /tmp/pgdata -o '-p 5433 -k /tmp/pgrun -c listen_addresses=127.0.0.1' -l /tmp/pg.log start" >/dev/null 2>&1
for i in $(seq 1 20); do
  psql -h 127.0.0.1 -p 5433 -U postgres -tAc 'select 1' >/dev/null 2>&1 && { echo "postgres up"; exit 0; }
  sleep 1
done
echo "postgres failed to start"; tail -10 /tmp/pg.log; exit 1
