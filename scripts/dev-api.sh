#!/usr/bin/env bash
# Start (or restart) the API in the background for local verification.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE=/tmp/dawaee-api.pid
if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null; sleep 1; fi
cd "$ROOT/apps/api"
nohup node --env-file="$ROOT/.env" "$ROOT/node_modules/.bin/tsx" src/index.ts > /tmp/api.log 2>&1 &
echo $! > "$PIDFILE"
sleep 6
curl -sf http://localhost:8080/health >/dev/null && echo "api up (pid $(cat "$PIDFILE"))" || { echo "api failed to start:"; tail -20 /tmp/api.log; exit 1; }
