# PR #25 release readiness — 14 September 2026

**BLOCKED for production.** Production inspection remains read-only; the new
backup/restore rehearsal uses disposable synthetic data. No production backup,
device test, production migration or deployment is claimed. The migration set
reviewed is the 80 files in candidate `80208bffab2e09b72ed932f392e6a505f900e85e`.
The preflight correction and subsequent recovery rehearsal do not change a
numbered migration. Record CI for the resulting commit separately.

## Current baseline and rollback blocker

The Dawaee Supabase project is `knkuxdfnfokqxbgnxzpe`, database `postgres`,
PostgreSQL 17.6. The application ledger has 0001–0033 plus the deliberate 0047
worker hotfix: 34 matching MD5s, no unknown filenames, 46 pending migrations.
The separate Supabase migration registry is not the application ledger.

| Component | Recorded live identity | Recovery status |
| --- | --- | --- |
| API | `4cf23531dfaa5cc7c3790b473f8b4ff9f88d9f72`, deploy `dep-dajgcue7bikc73bvq9j0` | **Incompatible stock conflict target after 0037**, by source inspection |
| Worker | `0338ddefc475d23cccecf13d5ede0f32d2007fb0`, deploy `dep-dai8atfqj5pc739j2vu0` | **Direct cleanup of stored_objects loses access after 0039**, by source inspection |

In that exact API source, `apps/api/src/services/dose-service.ts` inserts stock
movements with `ON CONFLICT (dose_occurrence_id, reason) WHERE
dose_occurrence_id IS NOT NULL`. Migration 0037 drops `stock_tx_dose_idx` and
introduces uniqueness on `dose_event_id` instead. The old statements no longer
have their matching unique index. The old schema startup checker explicitly
allows a newer database, so successful startup would not catch this functional
incompatibility. This is source-level evidence; no patient dose was changed to
reproduce it.

**Do not start production migrations under the current rollback plan.** First
prove a compatible recovery build, or approve and rehearse a maintenance/restore
plan with the write-loss window defined. Do not reinstate the old uniqueness
constraint as a shortcut: it would undo the take/undo/re-take ledger correction.
Apply the pending set to a restored copy and test both exact rollback builds
there, including stock-backed dose actions and worker jobs.

Canonical auto-deploy is still enabled for both services, and the API's live
health check remains `/health/ready`. The candidate's controlled release uses
auto-deploy off and `/health` for Render's continuous liveness checks, followed
by an explicit `/health/ready` acceptance gate once API and worker agree.
No live settings were changed in this review.

## Read-only database evidence

At **2026-09-14 09:06:17 UTC**, the checked-in
[`2026-09-14-data-precheck.sql`](2026-09-14-data-precheck.sql) ran on the intended
project under an existing administrative read context. It uses a read-only
transaction, a 10-second statement timeout, and returns aggregates only.

| Check | Observed result | Meaning |
| --- | --- | --- |
| Schedule/stock and refill/stock unit mismatches | 0 each | 0034 assertions found no current blocker |
| Caregiver rule/profile, escalation/medication, dose/schedule graph mismatches | 0 each | 0068–0070 current data checks passed |
| Notification dose/profile, medication/profile, dose/medication, patient recipient mismatches | 0 each | Four 0071 current data checks passed |
| Stock/dose graph and consent/owner mismatches | 0 each | Checked baseline edges for 0072/0073 passed |
| Enabled SMS/WhatsApp caregiver rules | 4 | 0035 will disable these rules |
| Non-snoozed occurrences retaining a snooze deadline | 2 | 0036 will clear obsolete deadlines |
| Proposed latest-event client ID backfill | 17 rows; 0 duplicate groups | Estimated 0045 backfill from the current snapshot |
| Pending unauthorized summary deliveries | 0 | No current 0049 suppression rows |
| Active push endpoints with one live session / to retire | 0 / 0 | No active endpoints in this snapshot; does not prove phone registration |
| Accounts past the 14-day erasure grace period | 0 | No current due account; re-check actual release policy/time |
| New event ID, client event ID, session ID and provider receipt columns | All four absent | Consistent with the unrecorded schema steps |

The stock/event check in 0072 depends on the column introduced by 0037 and must
run after the restored upgrade. The aggregate queries do not execute new
triggers, test concurrent traffic, establish a lock-duration bound, or prove all
historical rows comply with every new trigger. Re-run at release time.

Catalogue inspection found all 30 application tables owned by `dawaee_owner`;
the 27 RLS tables have RLS enabled and forced. The owner and runtime roles are
neither superusers nor BYPASSRLS. The owner can administer roles. The new
catalogue preflight also passed as `SET LOCAL ROLE dawaee_owner` inside a
read-only transaction, with **0 missing definer policies**. This verifies the SQL
checker, not the full shell preflight with production connection credentials.
`pg_trgm`, `btree_gist` and `pgcrypto` are already in `extensions`; do not repeat
extension relocation. No fresh Security Advisor result is claimed here.

## Review of every pending migration

DDL below can lock referenced tables; ordinary index builds block writes while
building. Measure duration on the restored copy and choose the release window
from that result. There are no generic down migrations. Reverting code does not
undo DML, restore removed indexes, reverse erasure, or reinstate old privileges.
“Function” means its body changes for future calls, not that its DML executes
at migration time. Rows marked “trigger” take effect on subsequent writes.

| File | DDL / immediate DML | Rehearsal and recovery concern |
| --- | --- | --- |
| 0034_stock_unit_consistency.sql | Two data assertions; function and 3 triggers | Rejects mismatches; later stock/schedule writes must use matching units |
| 0035_disable_unavailable_caregiver_channels.sql | UPDATE unsupported rules to disabled | 4 current rows; code rollback does not re-enable them |
| 0036_clear_terminal_snooze_state.sql | UPDATE stale snooze deadlines to NULL | 2 current rows; prior deadlines are not recoverable by code rollback |
| 0037_stock_ledger_event_identity.sql | New FK column; drop old unique index; build 2 indexes | **Recorded old API stock SQL is incompatible**; preserve event history |
| 0038_execute_account_erasure.sql | Relax creator nullability; replace 8 FKs; cleanup/erasure functions | FK validation and table locks; future erasure needs database and object recovery |
| 0039_worker_retention_boundaries.sql | 3 bounded functions; revoke direct object access | Old worker cleanup privileges must be rehearsed |
| 0040_account_erasure_audit_detach.sql | Replace audit-detachment and erasure functions | Verify append-only audit and sanctioned FK detachment |
| 0041_medication_external_reference_integrity.sql | Function and reference trigger | Existing rows not scanned; future prescription/image changes may be rejected |
| 0042_dose_snooze_status_invariant.sql | Function and normalization trigger | Subsequent terminal writes clear stale snooze state |
| 0043_caregiver_notification_permission_revocation.sql | Permission trigger; operational-table grants | Trigger suppresses pending deliveries; old operational writes may fail |
| 0044_logout_refresh_descendant_revocation.sql | Replace logout function | Intermediate definition; superseded before release by 0060 |
| 0045_dose_client_event_history.sql | New column; backfill latest events; build unique index | 17 proposed rows, zero duplicate groups now; verify full backfill on restore |
| 0046_push_token_account_switch.sql | Transfer function and trigger | Concurrent account/device registration; active endpoint ownership changes |
| 0048_admin_operational_read_model.sql | 3 aggregate/operational functions and grants | Exercise admin role boundary and new read contract |
| 0049_caregiver_digest_permission_revocation.sql | UPDATE pending digests; function and trigger | Suppression cannot be undone by code rollback; 0 current rows |
| 0050_logout_deactivates_push_token.sql | Replace logout function | Intermediate behavior; final logout is 0060 |
| 0051_session_revocation_push_boundary.sql | Function and session trigger | Intermediate endpoint retirement; final definition in 0061 |
| 0052_expired_session_push_boundary.sql | Replace token lookup function | Expired endpoints stop being eligible; final definition in 0061 |
| 0053_runtime_operational_tables_read_only.sql | Revoke API table privileges; grant SELECT | Old operational writes are intentionally refused |
| 0054_password_change_refresh_serialization.sql | Replace password and refresh functions | Account advisory lock; rehearse auth concurrency and lock ordering |
| 0055_account_erasure_profile_object_ownership.sql | Replace erasure object enumeration | Future object deletion includes owned profile objects regardless of uploader |
| 0056_deletion_pending_push_guard.sql | Function and activation trigger | Pending deletion blocks reactivation; verify old registration behavior |
| 0057_password_change_push_collision.sql | Credential marker and revocation functions/trigger | Transaction-local behavior; later revocation definition supersedes it |
| 0058_refresh_reuse_lineage_isolation.sql | Replace refresh function | Intermediate lineage behavior; final definition in 0061 |
| 0059_unreplaced_session_revocation_push_boundary.sql | Replace revocation function | Intermediate behavior; final exact-session boundary in 0061 |
| 0060_logout_refresh_lineage_isolation.sql | Replace logout function and grants | Final logout serializes with refresh; exercise existing clients |
| 0061_push_token_session_binding.sql | FK column/index; bind unambiguous tokens; deactivate others; functions/trigger | No active rows now; ambiguous/expired registrations require renewed binding |
| 0062_note_measurement_dose_profile_integrity.sql | Function and 2 triggers | Existing rows not scanned; future history edges must match patient |
| 0063_account_disable_refresh_serialization.sql | Function and user trigger | Account advisory lock with refresh; test disable/re-enable |
| 0064_dose_event_profile_integrity.sql | Function and event trigger | Future audit events must match their dose profile |
| 0065_logout_all_refresh_serialization.sql | Current-account lock function and grant | API must use lock before logout-all session mutation |
| 0066_symptom_note_length_contract.sql | Replace CHECK at 2000 characters | Validation scan; older clients may retain 1000-character limits |
| 0067_session_delete_push_binding.sql | Function and before-delete trigger | Retention retires the exact endpoint before session FK detachment |
| 0068_caregiver_notification_rule_profile_integrity.sql | Data assertion; function and trigger | Current mismatches 0; no automatic historical repair |
| 0069_medication_profile_graph_integrity.sql | Data assertion; 2 functions/triggers | Parent movement constrained; current escalation mismatches 0 |
| 0070_dose_schedule_graph_integrity.sql | Data assertion; 2 functions/triggers | Parent changes constrained; current dose/schedule mismatches 0 |
| 0071_notification_delivery_clinical_graph_integrity.sql | 4 data assertions; function and trigger | Current mismatches 0; subsequent worker delivery writes checked |
| 0072_stock_transaction_clinical_graph_integrity.sql | 2 assertions; function and trigger | Dose edge checked now; event edge requires 0037 column on restore |
| 0073_consent_profile_owner_integrity.sql | Data assertion; function and trigger | Current mismatches 0; future scoped consent must match an owner |
| 0074_patient_profile_identity_reassignment.sql | Function and profile trigger | Runtime owner/linked identity reassignment constrained |
| 0075_push_delivery_receipts.sql | JSON column/CHECK; 2 functions and grants | Validate receipts; provider acceptance is not receipt/viewing |
| 0076_push_endpoint_exact_session.sql | Replace endpoint lookup | New worker relies on exact live-session eligibility |
| 0077_push_receipt_claim_recovery.sql | Temporary receipt-claim function/grant | Removed by 0080 in the same pending set; never release midway |
| 0078_push_receipt_token_generation.sql | Retire worker's old overload; add fingerprint overload | Old receipt workers may lose capability; verify exact rollback worker |
| 0079_audit_preview_ledger_repair.sql | Conditional DELETE of two checksum-pinned preview ledger rows | No-op on production database `postgres`; preserves production history |
| 0080_remove_unused_push_receipt_claim.sql | Revoke and DROP unused function | No generic recreation on code rollback; current worker does not call it |

## Backup, restore and recovery evidence still required

No production backup identifier, timestamp, downloadable backup or successful
production-backup restoration was available in this session. A historical migration name containing “backup”
is not backup evidence. No Supabase development branches currently exist for
this project; an empty branch would not itself constitute a restored copy.

Use the [project backup dashboard](https://supabase.com/dashboard/project/knkuxdfnfokqxbgnxzpe/database/backups)
to record the actual restore point and source identity, then restore to an
isolated approved target. Supabase documents plan-dependent backup availability,
manual exports for free projects, custom-role password handling and the exclusion
of stored object bodies from database backups. Verify those recovery components
separately. [Supabase backup documentation](https://supabase.com/docs/guides/platform/backups).

The recovery record must contain: source/target project identity, backup ID and
UTC timestamp, artifact digest when exported, included schemas and object-store
coverage, owner/runtime-role mapping, restore duration, restored ledger/checksums,
the exact upgrade logs, second-run no-op, RLS probe, old/new binary behavior and
the measured data-loss window. Runtime roles must remain NOSUPERUSER/NOBYPASSRLS.
Follow the main release runbook for the second operator's restore authorization.
Do not export patient backups into Git, test logs or this report.

The [synthetic recovery rehearsal](2026-09-14-recovery-rehearsal.md) now covers
real `pg_dump` / `pg_restore`, the 34-to-80 ledger path, current stock and cleanup
behavior and recovery of the original SQL contracts. It deliberately demonstrates
that post-backup writes and deleted object bytes do not return with a database
restore. Its success marker and exact candidate CI are required before calling
that regression verified; production-scale recovery and full old-binary tests
remain separate release gates.

## Installed-device test preparation

| Item | Verified configuration / gap |
| --- | --- |
| App identity | Expo owner `naif789`, project `a7d1638b-045d-4fa3-957f-22d818c51abd`, Android/iOS ID `app.dawaee.mobile`, version 0.1.0 / build 2 |
| Current `preview` EAS profile | Internal Android APK and physical iOS, but URL still points to the old production API |
| Existing audit preview | `srv-daipkbuk1f9s73952trg`, live commit `14de48ea95ef0e11a6bc4addd88e87a83fbdc367` on another audit branch |
| Existing preview runtime | `scripts/audit-preview-start.mjs` fixes push to mock and starts only an API; it cannot prove real caregiver push delivery |
| Build/backup access here | No configured `EXPO_TOKEN`, `SUPABASE_ACCESS_TOKEN` or database connection URL; no installed device connection |
| Physical Android / iPhone evidence | NOT RUN |

Before requesting an installable build, provision/approve a synthetic test
environment with API **and worker** on the selected candidate, isolated data and
the intended push credentials. Select its URL explicitly in the test build;
do not count a build targeting the old production API as candidate evidence.
Verify signing, installed app/project identity and OS notification permission.
Then execute the [caregiver checklist](../caregiver-push-release-checklist.md)
with two followed people and record foreground/background/cold start, newer
taps, both locks, account switching, revocation and delayed confirmation. Record
provider acceptance, device receipt and user opening as three different events.

## Automated verification of this correction

The local Node 22 Vitest run passed 14 checks across the role-handoff, production
runbook and Render release-control suites. Four new PostgreSQL integration cases
verify unchanged catalogue row versions, no missing-policy repair during
inspection, rejection of disabled RLS and rejection of runtime roles. These
must pass on both PostgreSQL 16 and 17 in the final candidate CI. The normal
deploy path retains policy maintenance before and after migrations.
