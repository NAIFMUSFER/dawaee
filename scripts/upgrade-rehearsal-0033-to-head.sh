#!/usr/bin/env bash
# Rehearse the actual production-shaped upgrade path: schema 0033 -> current head.
# CI only. No network/provider/production access.
set -euo pipefail

DB="${1:-dawaee_upgrade_0033}"
BAD_DB="${DB}_unsafe"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
MIGRATOR="${DAWAEE_MIGRATOR_ROLE:-dawaee_migrator}"
MIGRATOR_PW="${DAWAEE_MIGRATOR_PASSWORD:-migratorpw}"
export PGHOST PGPORT PGUSER
export DAWAEE_APP_PASSWORD="${DAWAEE_APP_PASSWORD:-devpass}"
export DAWAEE_WORKER_PASSWORD="${DAWAEE_WORKER_PASSWORD:-devpass}"

TMP_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_ROOT"
  psql -q -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1 || true
  psql -q -d postgres -c "DROP DATABASE IF EXISTS \"$BAD_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "UPGRADE REHEARSAL FAIL: $*" >&2; exit 1; }
step() { echo "--- $*"; }

U1='11111111-1111-4111-8111-111111111111'
U2='22222222-2222-4222-8222-222222222222'
P1='33333333-3333-4333-8333-333333333331'
P2='33333333-3333-4333-8333-333333333332'
RX1='44444444-4444-4444-8444-444444444441'
RX2='44444444-4444-4444-8444-444444444442'
M1='55555555-5555-4555-8555-555555555551'
S1='66666666-6666-4666-8666-666666666661'
D1='77777777-7777-4777-8777-777777777771'
REL='88888888-8888-4888-8888-888888888881'
RULE_WA='99999999-9999-4999-8999-999999999991'
RULE_PUSH='99999999-9999-4999-8999-999999999992'
DEL_SENDING='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
DEL_QUEUED='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
OBJ1='cccccccc-cccc-4ccc-8ccc-ccccccccccc1'

# Build a temporary release root containing the exact migration runner but only
# the migrations production has already recorded. GitHub diff evidence for this
# audit verifies 0001..0033 and migrate.sh are unchanged from production main.
step "constructing exact 0033 migration set"
mkdir -p "$TMP_ROOT/scripts" "$TMP_ROOT/db/migrations" "$TMP_ROOT/db/maintenance"
cp "$ROOT/scripts/migrate.sh" "$TMP_ROOT/scripts/migrate.sh"
cp "$ROOT/db/maintenance/definer_policies.sql" "$TMP_ROOT/db/maintenance/definer_policies.sql"
BASELINE_COUNT=0
for f in "$ROOT"/db/migrations/*.sql; do
  base="$(basename "$f")"
  num="${base%%_*}"
  if [ $((10#$num)) -le 33 ]; then
    cp "$f" "$TMP_ROOT/db/migrations/$base"
    BASELINE_COUNT=$((BASELINE_COUNT + 1))
  fi
done
[ "$BASELINE_COUNT" -eq 33 ] || fail "expected 33 baseline migrations, copied $BASELINE_COUNT"

"$ROOT/scripts/db-bootstrap-roles.sh" "$DB" >/dev/null
MIGRATOR_URL="postgres://${MIGRATOR}:${MIGRATOR_PW}@${PGHOST}:${PGPORT}"
APP_URL="postgres://dawaee_app:${DAWAEE_APP_PASSWORD}@${PGHOST}:${PGPORT}"
WORKER_URL="postgres://dawaee_worker:${DAWAEE_WORKER_PASSWORD}@${PGHOST}:${PGPORT}"

create_baseline() {
  local name="$1"
  psql -q -d postgres -c "DROP DATABASE IF EXISTS \"$name\" WITH (FORCE)" >/dev/null
  psql -q -d postgres -c "CREATE DATABASE \"$name\" OWNER $MIGRATOR" >/dev/null
  DATABASE_URL="$MIGRATOR_URL/$name" bash "$TMP_ROOT/scripts/migrate.sh" >/dev/null
  local count latest
  count="$(psql -d "$name" -tAc 'SELECT count(*) FROM schema_migrations')"
  latest="$(psql -d "$name" -tAc 'SELECT max(filename) FROM schema_migrations')"
  [ "$count" = "33" ] || fail "$name baseline ledger has $count rows, expected 33"
  [ "$latest" = "0033_caregiver_revoke_notification_policy.sql" ] \
    || fail "$name baseline ended at $latest, not 0033"
}

snapshot_counts() {
  local name="$1"
  psql -d "$name" -Atc "
    SELECT label || '=' || n FROM (
      SELECT 'audit_logs' label, count(*) n FROM audit_logs UNION ALL
      SELECT 'caregiver_notification_rules', count(*) FROM caregiver_notification_rules UNION ALL
      SELECT 'caregiver_relationships', count(*) FROM caregiver_relationships UNION ALL
      SELECT 'dose_events', count(*) FROM dose_events UNION ALL
      SELECT 'dose_occurrences', count(*) FROM dose_occurrences UNION ALL
      SELECT 'medication_schedules', count(*) FROM medication_schedules UNION ALL
      SELECT 'medication_stock', count(*) FROM medication_stock UNION ALL
      SELECT 'medications', count(*) FROM medications UNION ALL
      SELECT 'notification_deliveries', count(*) FROM notification_deliveries UNION ALL
      SELECT 'patient_profiles', count(*) FROM patient_profiles UNION ALL
      SELECT 'prescriptions', count(*) FROM prescriptions UNION ALL
      SELECT 'refill_events', count(*) FROM refill_events UNION ALL
      SELECT 'stock_transactions', count(*) FROM stock_transactions UNION ALL
      SELECT 'stored_objects', count(*) FROM stored_objects UNION ALL
      SELECT 'users', count(*) FROM users
    ) s ORDER BY label"
}

step "building production-shaped schema 0033 database"
create_baseline "$DB"

step "seeding migration-sensitive 0033 state"
psql -v ON_ERROR_STOP=1 -q -d "$DB" <<SQL
INSERT INTO users (id, phone_e164, display_name)
VALUES
  ('$U1', '+966500000101', 'Upgrade Patient'),
  ('$U2', '+966500000102', 'Upgrade Caregiver');
UPDATE users SET deletion_requested_at = now() - interval '15 days' WHERE id = '$U2';

INSERT INTO patient_profiles (id, owner_user_id, display_name, timezone, home_timezone, is_self)
VALUES
  ('$P1', '$U1', 'Self', 'Asia/Riyadh', 'Asia/Riyadh', true),
  ('$P2', '$U1', 'Dependent', 'Asia/Riyadh', 'Asia/Riyadh', false);

INSERT INTO stored_objects
  (id, object_key, owner_user_id, patient_profile_id, purpose, content_type, byte_size, scan_status, uploaded_at)
VALUES
  ('$OBJ1', 'upgrade/p1/medication.jpg', '$U2', '$P1', 'medication_image', 'image/jpeg', 2048, 'clean', now());

INSERT INTO prescriptions (id, patient_profile_id, reference, created_by)
VALUES
  ('$RX1', '$P1', 'RX-P1', '$U2'),
  ('$RX2', '$P2', 'RX-P2', '$U1');

INSERT INTO medications
  (id, patient_profile_id, name, form, image_key, start_date, prescription_id, created_by)
VALUES
  ('$M1', '$P1', 'Upgrade Medicine', 'tablet', 'upgrade/p1/medication.jpg', '2026-09-01', '$RX1', '$U2');

INSERT INTO medication_stock
  (medication_id, patient_profile_id, unit, initial_quantity, remaining_quantity)
VALUES ('$M1', '$P1', 'tablet', 30, 29);

INSERT INTO medication_schedules
  (id, medication_id, patient_profile_id, rule_kind, rule, dose_quantity, dose_unit,
   timezone, start_date, created_by)
VALUES
  ('$S1', '$M1', '$P1', 'fixed_times', '{"kind":"fixed_times","times":["08:00"]}'::jsonb,
   1, 'tablet', 'Asia/Riyadh', '2026-09-01', '$U2');

INSERT INTO refill_events
  (medication_id, patient_profile_id, quantity_added, unit, created_by)
VALUES ('$M1', '$P1', 10, 'tablet', '$U2');

INSERT INTO dose_occurrences
  (id, schedule_id, medication_id, patient_profile_id, scheduled_at, scheduled_local_date,
   scheduled_local_time, scheduled_timezone, dose_quantity, dose_unit, status,
   snoozed_until, confirmed_at, confirmed_by_user_id, confirmation_method)
VALUES
  ('$D1', '$S1', '$M1', '$P1', '2026-09-10T05:00:00Z', '2026-09-10', '08:00',
   'Asia/Riyadh', 1, 'tablet', 'taken', '2026-09-10T06:00:00Z',
   '2026-09-10T05:01:00Z', '$U2', 'app');

INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, actor_user_id, method)
VALUES ('$D1', '$P1', 'taken', '$U2', 'app');

INSERT INTO stock_transactions
  (medication_id, patient_profile_id, delta, reason, dose_occurrence_id, balance_after, actor_user_id)
VALUES ('$M1', '$P1', -1, 'dose_taken', '$D1', 29, '$U2');

INSERT INTO caregiver_relationships
  (id, patient_profile_id, caregiver_user_id, invited_phone_e164, invited_name, role, status,
   permissions, escalation_priority, invited_by_user_id, accepted_at)
VALUES
  ('$REL', '$P1', '$U2', '+966500000102', 'Upgrade Caregiver', 'caregiver', 'active',
   ARRAY['view_adherence','receive_notifications'], 1, '$U1', now());

INSERT INTO caregiver_notification_rules
  (id, relationship_id, patient_profile_id, channel, mode, enabled)
VALUES
  ('$RULE_WA', '$REL', '$P1', 'whatsapp', 'missed_only', true),
  ('$RULE_PUSH', '$REL', '$P1', 'push', 'missed_only', true);

INSERT INTO notification_deliveries
  (id, patient_profile_id, recipient_user_id, relationship_id, kind, channel, status,
   locale, title, body, dedupe_key, scheduled_for, next_attempt_at, attempts, lease_until, lease_token)
VALUES
  ('$DEL_SENDING', '$P1', '$U2', '$REL', 'escalation', 'push', 'sending',
   'en', 'Care alert', 'Needs attention', 'upgrade-sending', now(), now(), 1,
   now() + interval '10 minutes', gen_random_uuid()),
  ('$DEL_QUEUED', '$P1', '$U2', '$REL', 'escalation', 'push', 'queued',
   'en', 'Care alert', 'Needs attention', 'upgrade-queued', now(), now(), 0, NULL, NULL);

INSERT INTO audit_logs
  (actor_user_id, actor_role, patient_profile_id, action, entity_type, entity_id)
VALUES ('$U2', 'caregiver', '$P1', 'upgrade.rehearsal', 'medication', '$M1');
SQL

snapshot_counts "$DB" > /tmp/dawaee-upgrade-before.txt

step "running the real migration runner from 0033 to head"
export DATABASE_URL="$MIGRATOR_URL/$DB"
bash "$ROOT/scripts/migrate.sh" | tee /tmp/dawaee-upgrade-first.txt
UPGRADE_APPLIED="$(grep -Eo 'applied [0-9]+ migration\(s\)' /tmp/dawaee-upgrade-first.txt | tail -1 || true)"
[ "$UPGRADE_APPLIED" = "applied 10 migration(s)" ] \
  || fail "expected exactly 10 migrations (0034..0043), got: ${UPGRADE_APPLIED:-none}"

LATEST="$(psql -d "$DB" -tAc 'SELECT max(filename) FROM schema_migrations')"
COUNT="$(psql -d "$DB" -tAc 'SELECT count(*) FROM schema_migrations')"
[ "$COUNT" = "43" ] || fail "upgraded ledger has $COUNT rows, expected 43"
[ "$LATEST" = "0043_caregiver_notification_permission_revocation.sql" ] \
  || fail "upgraded ledger ended at $LATEST, not 0043"

bash "$ROOT/scripts/migrate.sh" | tee /tmp/dawaee-upgrade-second.txt
 grep -q 'no pending migrations' /tmp/dawaee-upgrade-second.txt \
  || fail "second migration run was not a no-op"

snapshot_counts "$DB" > /tmp/dawaee-upgrade-after.txt
if ! diff -u /tmp/dawaee-upgrade-before.txt /tmp/dawaee-upgrade-after.txt; then
  fail "0033 -> 0043 changed row counts outside schema_migrations"
fi

step "verifying intended data transformations and schema integrity"
[ "$(psql -d "$DB" -tAc "SELECT enabled::text FROM caregiver_notification_rules WHERE id='$RULE_WA'")" = "false" ] \
  || fail "0035 did not disable the legacy WhatsApp rule"
[ "$(psql -d "$DB" -tAc "SELECT enabled::text FROM caregiver_notification_rules WHERE id='$RULE_PUSH'")" = "true" ] \
  || fail "0035 disabled the supported push rule"

DOSE_STATE="$(psql -d "$DB" -tAc "SELECT status::text || '|' || COALESCE(snoozed_until::text,'NULL') FROM dose_occurrences WHERE id='$D1'")"
[ "$DOSE_STATE" = "taken|NULL" ] || fail "0036/0042 left terminal dose state inconsistent: $DOSE_STATE"
[ "$(psql -d "$DB" -tAc "SELECT (confirmed_at IS NOT NULL)::text FROM dose_occurrences WHERE id='$D1'")" = "true" ] \
  || fail "dose confirmation metadata was lost"

[ "$(psql -d "$DB" -tAc "SELECT (dose_event_id IS NULL)::text FROM stock_transactions WHERE dose_occurrence_id='$D1'")" = "true" ] \
  || fail "0037 rewrote historical stock ledger identity unexpectedly"
[ "$(psql -d "$DB" -tAc "SELECT (to_regclass('public.stock_tx_dose_idx') IS NULL)::text")" = "true" ] \
  || fail "0037 left the old lifetime-unique stock index behind"
[ "$(psql -d "$DB" -tAc "SELECT indisvalid::text FROM pg_index WHERE indexrelid='public.stock_tx_dose_event_idx'::regclass")" = "true" ] \
  || fail "0037 new stock event index is not valid"

INVALID_INDEXES="$(psql -d "$DB" -tAc "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app') AND NOT i.indisvalid")"
[ "$INVALID_INDEXES" = "0" ] || fail "$INVALID_INDEXES invalid indexes after upgrade"
UNVALIDATED="$(psql -d "$DB" -tAc "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('public','app') AND NOT c.convalidated")"
[ "$UNVALIDATED" = "0" ] || fail "$UNVALIDATED unvalidated constraints after upgrade"

[ "$(psql -d "$DB" -tAc "SELECT has_table_privilege('dawaee_worker','public.stored_objects','SELECT')::text")" = "false" ] \
  || fail "0039 left worker raw SELECT on stored_objects"
[ "$(psql -d "$DB" -tAc "SELECT has_table_privilege('dawaee_worker','public.stored_objects','DELETE')::text")" = "false" ] \
  || fail "0039 left worker raw DELETE on stored_objects"
[ "$(psql -d "$DB" -tAc "SELECT has_function_privilege('dawaee_worker','app.erase_due_account(uuid,integer)','EXECUTE')::text")" = "true" ] \
  || fail "worker cannot execute the bounded erasure function"

step "proving 0041 rejects a cross-profile prescription through the runtime role"
set +e
psql "$APP_URL/$DB" -v ON_ERROR_STOP=1 -q >/tmp/dawaee-upgrade-crossref.out 2>/tmp/dawaee-upgrade-crossref.err <<SQL
BEGIN;
SELECT set_config('app.user_id', '$U1', true);
UPDATE medications SET prescription_id = '$RX2' WHERE id = '$M1';
COMMIT;
SQL
CROSSREF_EXIT=$?
set -e
[ "$CROSSREF_EXIT" -ne 0 ] || fail "0041 accepted a cross-profile prescription reference"
grep -q 'prescription does not belong to medication patient profile' /tmp/dawaee-upgrade-crossref.err \
  || fail "cross-profile write failed for an unexpected reason"
[ "$(psql -d "$DB" -tAc "SELECT prescription_id::text FROM medications WHERE id='$M1'")" = "$RX1" ] \
  || fail "failed cross-profile write changed the medication"

step "proving 0043 suppresses queued and leased deliveries through owner RLS"
psql "$APP_URL/$DB" -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
SELECT set_config('app.user_id', '$U1', true);
UPDATE caregiver_relationships
   SET permissions = ARRAY['view_adherence']::text[]
 WHERE id = '$REL';
COMMIT;
SQL
SUPPRESSED="$(psql -d "$DB" -tAc "SELECT count(*) FROM notification_deliveries WHERE relationship_id='$REL' AND status='skipped' AND lease_token IS NULL AND lease_until IS NULL")"
[ "$SUPPRESSED" = "2" ] || fail "0043 did not atomically suppress and de-lease both caregiver deliveries (got $SUPPRESSED)"

step "proving 0038/0040 erasure detaches caregiver attribution without deleting patient data"
ERASED="$(psql "$WORKER_URL/$DB" -tAc "SELECT app.erase_due_account('$U2'::uuid, 14)")"
[ "$ERASED" = "t" ] || fail "due caregiver account was not erased"
[ "$(psql -d "$DB" -tAc "SELECT count(*) FROM users WHERE id='$U2'")" = "0" ] || fail "erased caregiver user row survived"
[ "$(psql -d "$DB" -tAc "SELECT count(*) FROM medications WHERE id='$M1' AND patient_profile_id='$P1' AND created_by IS NULL")" = "1" ] \
  || fail "patient medication was deleted or creator attribution was not detached"
[ "$(psql -d "$DB" -tAc "SELECT count(*) FROM stored_objects WHERE id='$OBJ1' AND patient_profile_id='$P1' AND owner_user_id IS NULL")" = "1" ] \
  || fail "caregiver-uploaded patient object was deleted or owner attribution remained"
[ "$(psql -d "$DB" -tAc "SELECT count(*) FROM audit_logs WHERE action='upgrade.rehearsal' AND actor_user_id IS NULL AND patient_profile_id='$P1'")" = "1" ] \
  || fail "audit row was deleted or actor detachment failed"
[ "$(psql -d "$DB" -tAc "SELECT count(*) FROM users WHERE id='$U1'")" = "1" ] || fail "patient account was touched by caregiver erasure"

# Negative control: a unit mismatch that 0034 explicitly guards must stop the
# upgrade at 0033 and leave no partially-applied 0034 objects or ledger rows.
step "negative control: unsafe 0033 stock units fail closed before 0034 commits"
create_baseline "$BAD_DB"
BAD_U='dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
BAD_P='dddddddd-dddd-4ddd-8ddd-ddddddddddd2'
BAD_M='dddddddd-dddd-4ddd-8ddd-ddddddddddd3'
BAD_S='dddddddd-dddd-4ddd-8ddd-ddddddddddd4'
psql -v ON_ERROR_STOP=1 -q -d "$BAD_DB" <<SQL
INSERT INTO users (id, phone_e164, display_name) VALUES ('$BAD_U', '+966500000199', 'Unsafe Control');
INSERT INTO patient_profiles (id, owner_user_id, display_name, is_self) VALUES ('$BAD_P', '$BAD_U', 'Unsafe', true);
INSERT INTO medications (id, patient_profile_id, name, form, start_date, created_by)
VALUES ('$BAD_M', '$BAD_P', 'Unsafe Medicine', 'tablet', '2026-09-01', '$BAD_U');
INSERT INTO medication_stock (medication_id, patient_profile_id, unit, initial_quantity, remaining_quantity)
VALUES ('$BAD_M', '$BAD_P', 'tablet', 30, 30);
INSERT INTO medication_schedules
  (id, medication_id, patient_profile_id, rule_kind, rule, dose_quantity, dose_unit, start_date, created_by)
VALUES ('$BAD_S', '$BAD_M', '$BAD_P', 'fixed_times', '{"kind":"fixed_times","times":["08:00"]}'::jsonb,
        500, 'mg', '2026-09-01', '$BAD_U');
SQL

set +e
DATABASE_URL="$MIGRATOR_URL/$BAD_DB" bash "$ROOT/scripts/migrate.sh" >/tmp/dawaee-upgrade-unsafe.out 2>/tmp/dawaee-upgrade-unsafe.err
BAD_EXIT=$?
set -e
[ "$BAD_EXIT" -ne 0 ] || fail "0034 accepted an existing schedule/stock unit mismatch"
grep -q 'existing medication schedule/stock unit mismatch' /tmp/dawaee-upgrade-unsafe.err \
  || fail "unsafe upgrade failed for an unexpected reason"
[ "$(psql -d "$BAD_DB" -tAc "SELECT count(*) FROM schema_migrations WHERE filename >= '0034'")" = "0" ] \
  || fail "unsafe upgrade partially advanced the migration ledger"
[ "$(psql -d "$BAD_DB" -tAc "SELECT (to_regclass('public.medication_schedule_stock_unit_guard') IS NULL)::text")" = "true" ] \
  || fail "0034 left a partial trigger behind after refusal"

cat <<EOF

PRODUCTION-SHAPED UPGRADE REHEARSAL PASSED
  baseline          : 0033_caregiver_revoke_notification_policy.sql
  upgraded through : $LATEST
  pending migrations: 10 (0034..0043), then no-op
  row-count drift   : none before explicit post-upgrade actions
  intended cleanup : legacy WhatsApp disabled; terminal snooze metadata cleared
  stock integrity   : new event identity index valid; historical ledger retained
  privilege model   : worker raw stored-object access revoked; bounded erasure works
  cross-profile     : mismatched prescription rejected structurally
  caregiver revoke : queued/sending deliveries skipped and leases invalidated
  erasure           : caregiver attribution detached; patient medication/object/audit preserved
  unsafe control    : 0034 refused mismatched units atomically at schema 0033
EOF
