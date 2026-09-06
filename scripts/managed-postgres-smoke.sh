#!/usr/bin/env bash
# Starts the API against a realistically-owned database and exercises it.
#
# WHY THIS EXISTS
#
# CI already built a database owned by a non-superuser and ran migrations plus
# the RLS probe against it. That job passed for months while the product was
# unusable on exactly that configuration: `app.register_with_password` could not
# INSERT `user_credentials` under FORCE ROW LEVEL SECURITY, and registration
# returned 404. Nothing caught it because the application was never STARTED
# against that database — only the schema was.
#
# A migration-only PASS is not enough. This boots the real server and drives the
# real routes, so a definer path that cannot write is a failed build rather than
# a failed launch.
#
# Covered here, deliberately, one of each kind:
#   * a SECURITY DEFINER write path  — register  (users, patient_profiles,
#     user_preferences, user_credentials, four FORCE-RLS tables)
#   * a SECURITY DEFINER read path   — login     (app.find_user_for_password_login)
#   * an ordinary RLS read           — GET /v1/profiles
#   * an ordinary RLS write          — POST /v1/medications
#   * the tenancy boundary           — a second account must not see the first
#   * the startup gate               — a behind schema must refuse to boot
set -euo pipefail

DB="${1:-dawaee_smoke}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PORT="${SMOKE_PORT:-8099}"
BASE="http://127.0.0.1:${PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATOR="${DAWAEE_MIGRATOR_ROLE:-dawaee_migrator}"
MIGRATOR_PW="${DAWAEE_MIGRATOR_PASSWORD:-migratorpw}"
export PGHOST PGPORT
export PGUSER="${PGUSER:-postgres}"
export DAWAEE_APP_PASSWORD="${DAWAEE_APP_PASSWORD:-devpass}"
export DAWAEE_WORKER_PASSWORD="${DAWAEE_WORKER_PASSWORD:-devpass}"

API_PID=""
cleanup() { [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true; }
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
step() { echo "--- $*"; }

# ------------------------------------------------------------------ database
step "building $DB, owned by $MIGRATOR (NOSUPERUSER, NOBYPASSRLS)"
"$ROOT/scripts/db-reset.sh" "$DB" > /dev/null

OWNER_ATTRS="$(psql -tAc "SELECT rolsuper::text || ' ' || rolbypassrls::text FROM pg_roles WHERE rolname = '$MIGRATOR'")"
[ "$OWNER_ATTRS" = "false false" ] \
  || fail "the migration owner is not NOSUPERUSER NOBYPASSRLS (got: $OWNER_ATTRS) — this smoke would prove nothing"

DB_OWNER="$(psql -tAc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$DB'")"
[ "$DB_OWNER" = "$MIGRATOR" ] || fail "$DB is owned by $DB_OWNER, not $MIGRATOR"

# ---------------------------------------------------------------- the server
export NODE_ENV=development
export HOST=127.0.0.1
export PORT
export LOG_LEVEL=warn
export DATABASE_URL="postgres://dawaee_app:${DAWAEE_APP_PASSWORD}@${PGHOST}:${PGPORT}/${DB}"
export WORKER_DATABASE_URL="postgres://dawaee_worker:${DAWAEE_WORKER_PASSWORD}@${PGHOST}:${PGPORT}/${DB}"
export DATABASE_SSL=false
export JWT_SECRET="smoke_secret_at_least_thirty_two_characters_long_0123456789"
export IP_HASH_SALT="smoke-salt"
export SMS_PROVIDER=mock WHATSAPP_PROVIDER=mock PUSH_PROVIDER=mock OCR_PROVIDER=mock
export STORAGE_PROVIDER=local STORAGE_LOCAL_DIR=/tmp/dawaee-smoke-storage
export WORKER_ENABLED=false
export PUBLIC_APP_URL="$BASE"

step "starting the API"
node "$ROOT/apps/api/dist/index.js" > /tmp/smoke-api.log 2>&1 &
API_PID=$!

for i in $(seq 1 40); do
  sleep 0.5
  curl -fsS -m 2 "$BASE/health" > /dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { cat /tmp/smoke-api.log >&2; fail "the API exited during startup"; }
  [ "$i" = "40" ] && { cat /tmp/smoke-api.log >&2; fail "the API never became healthy"; }
done

# ----------------------------------------------------------------- readiness
step "readiness reports the schema"
READY="$(curl -fsS "$BASE/health/ready")"
echo "$READY" | grep -q '"status":"ready"' || fail "not ready: $READY"
echo "$READY" | grep -q '"schema"' || fail "readiness does not report the schema: $READY"

# ------------------------------------------------------------------- routes
ip() { echo "10.90.$((RANDOM % 250)).$((RANDOM % 250))"; }
PHONE_A="+9665$(printf '%08d' $((RANDOM % 90000000 + 10000000)))"
PHONE_B="+9665$(printf '%08d' $((RANDOM % 90000000 + 10000000)))"
PW='SmokeTest!Pass123'

register() {
  curl -sS -o /tmp/smoke-reg.json -w '%{http_code}' -X POST "$BASE/v1/auth/register" \
    -H 'content-type: application/json' -H "x-forwarded-for: $(ip)" \
    -d "{\"phone\":\"$1\",\"displayName\":\"smoke\",\"password\":\"$PW\",\"locale\":\"ar\",\"deviceId\":\"smoke-device-$2\"}"
}

step "POST /v1/auth/register  (SECURITY DEFINER write: 4 FORCE-RLS tables)"
CODE="$(register "$PHONE_A" a)"
[ "$CODE" = "200" ] || { echo "$(cat /tmp/smoke-reg.json)" >&2; tail -20 /tmp/smoke-api.log >&2; fail "register returned $CODE (expected 200)"; }
TOKEN_A="$(python3 -c 'import json;print(json.load(open("/tmp/smoke-reg.json"))["accessToken"])')"
[ -n "$TOKEN_A" ] || fail "register returned no access token"

CODE="$(register "$PHONE_B" b)"
[ "$CODE" = "200" ] || fail "second register returned $CODE"
TOKEN_B="$(python3 -c 'import json;print(json.load(open("/tmp/smoke-reg.json"))["accessToken"])')"

step "the credential really was written (only reachable through the definer path)"
CREDS="$(psql -tAc "SELECT count(*) FROM user_credentials uc JOIN users u ON u.id = uc.user_id WHERE u.phone_e164 = '$PHONE_A'" -d "$DB")"
[ "$CREDS" = "1" ] || fail "no credential row for $PHONE_A — registration reported success without writing one"

step "POST /v1/auth/login  (SECURITY DEFINER read)"
CODE="$(curl -sS -o /tmp/smoke-login.json -w '%{http_code}' -X POST "$BASE/v1/auth/login" \
  -H 'content-type: application/json' -H "x-forwarded-for: $(ip)" \
  -d "{\"identifier\":\"$PHONE_A\",\"password\":\"$PW\",\"deviceId\":\"smoke-a2\"}")"
[ "$CODE" = "200" ] || { cat /tmp/smoke-login.json >&2; fail "login returned $CODE"; }

step "GET /v1/profiles  (ordinary RLS read)"
CODE="$(curl -sS -o /tmp/smoke-prof.json -w '%{http_code}' "$BASE/v1/profiles" \
  -H "authorization: Bearer $TOKEN_A" -H "x-forwarded-for: $(ip)")"
[ "$CODE" = "200" ] || { cat /tmp/smoke-prof.json >&2; fail "GET /v1/profiles returned $CODE"; }
PROFILE_A="$(python3 -c '
import json
d=json.load(open("/tmp/smoke-prof.json"))
items = d["profiles"] if isinstance(d, dict) and "profiles" in d else d
print(items[0]["id"])')"
[ -n "$PROFILE_A" ] || fail "no profile was created for the new account"

step "POST /v1/medications  (ordinary RLS write)"
TODAY="$(date -u +%F)"
CODE="$(curl -sS -o /tmp/smoke-med.json -w '%{http_code}' -X POST "$BASE/v1/medications" \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN_A" -H "x-forwarded-for: $(ip)" \
  -d "{\"patientProfileId\":\"$PROFILE_A\",\"name\":\"ميتفورمين\",\"form\":\"tablet\",\"foodInstruction\":\"no_preference\",\"startDate\":\"$TODAY\",\"schedule\":{\"rule\":{\"kind\":\"fixed_times\",\"times\":[\"08:00\"]},\"doseQuantity\":1,\"doseUnit\":\"tablet\",\"startDate\":\"$TODAY\",\"missedAfterMinutes\":120,\"lateAfterMinutes\":15}}")"
[ "$CODE" = "200" ] || { cat /tmp/smoke-med.json >&2; fail "POST /v1/medications returned $CODE"; }

step "the tenancy boundary still holds on this configuration"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/v1/today?profileId=$PROFILE_A" \
  -H "authorization: Bearer $TOKEN_B" -H "x-forwarded-for: $(ip)")"
case "$CODE" in 403|404) ;; *) fail "account B reached account A's schedule (HTTP $CODE)" ;; esac

kill "$API_PID" 2>/dev/null || true
wait "$API_PID" 2>/dev/null || true
API_PID=""

# --------------------------------------------------- the startup gate itself
#
# A build must refuse to run against a schema it does not fit. Modelled by
# removing the ledger rows for everything after 0019 — the state production is
# in right now — and asserting the process exits instead of serving.
step "the startup gate refuses a schema that is behind"
psql -d "$DB" -q -c "CREATE TABLE IF NOT EXISTS _smoke_keep AS SELECT * FROM schema_migrations WHERE filename >= '0020'" \
  -c "DELETE FROM schema_migrations WHERE filename >= '0020'"

set +e
timeout 45 node "$ROOT/apps/api/dist/index.js" > /tmp/smoke-behind.log 2>&1
BEHIND_EXIT=$?
set -e

psql -d "$DB" -q -c "INSERT INTO schema_migrations SELECT * FROM _smoke_keep ON CONFLICT DO NOTHING" \
  -c "DROP TABLE _smoke_keep"

[ "$BEHIND_EXIT" != "0" ] || fail "the API started against a schema that is behind"
[ "$BEHIND_EXIT" != "124" ] || { cat /tmp/smoke-behind.log >&2; fail "the API hung instead of refusing"; }
grep -q "schema is incompatible" /tmp/smoke-behind.log \
  || { cat /tmp/smoke-behind.log >&2; fail "the API exited but not for the schema contract"; }
grep -qE "0020|0029|0030" /tmp/smoke-behind.log \
  || fail "the refusal did not name which migrations are missing"
# The VALUES, not the words: `0022_password_change_by_user_id.sql` is a
# filename the refusal is supposed to print, and grepping for "password"
# flagged it. A check that cries wolf on its own correct output is worse than
# no check, because the next person deletes it.
for secret in "$JWT_SECRET" "$IP_HASH_SALT" "$DAWAEE_APP_PASSWORD" "$DAWAEE_WORKER_PASSWORD" "$MIGRATOR_PW" "$DATABASE_URL"; do
  grep -qF -- "$secret" /tmp/smoke-behind.log && fail "the refusal leaked a secret value into the log"
done
grep -q "postgres://" /tmp/smoke-behind.log && fail "the refusal printed a connection string"

echo
echo "MANAGED-POSTGRES SMOKE PASSED"
echo "  database owner : $MIGRATOR (rolsuper=false, rolbypassrls=false)"
echo "  definer write  : register wrote users/profiles/preferences/credentials"
echo "  definer read   : password login"
echo "  RLS read       : GET /v1/profiles"
echo "  RLS write      : POST /v1/medications"
echo "  tenancy        : B could not reach A (HTTP $CODE)"
echo "  startup gate   : refused a behind schema, exit $BEHIND_EXIT"
