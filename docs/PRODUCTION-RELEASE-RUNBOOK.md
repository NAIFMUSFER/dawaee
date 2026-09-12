# Production release runbook

Current operational procedure for Dawaee production releases.

This document deliberately contains **no fixed production migration count or
fixed rollback SHA**. Those values become stale as soon as the audit branch
moves. The release artefact and the live `schema_migrations` ledger are the
sources of truth. Historical P17/P18 evidence remains in Git history and the
phase review documents; it is not an executable release plan.

No secret values belong in this file. Read secrets from the approved operator
surfaces and pass them only through the process environment.

---

## 0. Current audit evidence and open blockers

As of the 2026-09-11 audit:

- GitHub CI and Security gates have executed successfully on the current audit
  branch head for PostgreSQL 16 and 17, RLS, migrations, managed-Postgres smoke,
  unit/integration tests, mobile production exports, Docker, dependency checks,
  CodeQL, Gitleaks and Trivy. **Re-check the actual candidate SHA; do not inherit
  this PASS by assumption.**
- `main` and the currently deployed canonical Render services are behind the
  audit branch. Record the exact candidate SHA, resulting post-merge release SHA,
  and exact pre-release Render deploy IDs immediately before release; never use
  a SHA copied from this document.
- Fresh production worker evidence shows the `materialize` job failing with
  SQLSTATE `42501` / `permission denied for table dose_occurrences`. The audit
  branch contains the least-privilege remediation. Its disappearance after the
  worker release is a required production verification.
- Render platform request logs on the deployed build still contain stable
  profile/medication/dose/caregiver identifiers in request paths and queries.
  The audit branch moves those identifiers to fixed-path private-header
  transport, but this finding is **not closed until production logs after the
  cutover prove the identifiers are absent**.
- The canonical API is currently on a configuration that has produced cold-start
  HTTP 503s. The release candidate expects paid/non-sleeping service behaviour
  and `/health/ready` as the traffic gate. Verify the Render service after the
  deploy; repository configuration alone is not production proof.
- Four duplicate Dawaee Render services are fail-closed and have no working
  application instance. Do not delete or suspend them as part of this release;
  follow `docs/RENDER-CLEANUP-RUNBOOK.md` and obtain explicit operator approval.

No merge or deploy should begin while any release-blocking audit finding lacks
an explicit verification step below.

---

## 1. Preconditions

Do not begin until every line is true.

- [ ] The exact PR/audit branch head is recorded as `CANDIDATE_SHA`.
- [ ] All required GitHub checks are green on **that candidate SHA**. The active
      `main` ruleset requires PR-based integration and the configured CI/security
      checks; verify the ruleset still exists before relying on it.
- [ ] Canonical `dawaee-api` and `dawaee-worker` auto-deploy are off. Verify in
      Render even if they were already off during the audit.
- [ ] A named operator has Render, Supabase and `psql` access.
- [ ] A second operator is available for rollback authorization.
- [ ] The release window is chosen to minimize scheduled-dose impact.
- [ ] A production database backup/restore point from the last hour exists and
      its identifier and timestamp are recorded.
- [ ] The production `DATABASE_URL` host has been confirmed to be the intended
      production database before taking or trusting the backup.
- [ ] The intended push/OCR/storage provider state has been decided. `/health/ready`
      after deploy is authoritative for what the running API considers mocked or
      unavailable; do not infer provider readiness from repository defaults.

---

## 2. Freeze deployment and record rollback identities

Before merging anything:

1. Disable auto-deploy for the canonical API and worker in Render.
2. Leave the four duplicate fail-closed services disabled from any release
   workflow; do not configure secrets on them.
3. Record the current canonical deploy IDs and commit identities as:

```text
PRE_RELEASE_API_DEPLOY=<Render deploy id>
PRE_RELEASE_WORKER_DEPLOY=<Render deploy id>
PRE_RELEASE_API_SHA=<reported commit>
PRE_RELEASE_WORKER_SHA=<reported commit>
```

These recorded deploy IDs, not historical SHAs in documentation, are the only
approved R1/R2 rollback targets.

If the API and worker do not report the same expected pre-release release line,
stop and investigate release drift before proceeding.

---

## 3. Merge behind required checks and pin the release identity

Merge the audit/release branch to `main` only through the protected pull request
and only after all required checks are green on `CANDIDATE_SHA`.

Because canonical auto-deploy is disabled, merging must not start a production
deploy. If Render starts one unexpectedly, stop it before continuing and find
which deploy control or Blueprint sync re-enabled automation.

After merge, update local `main` and record the **post-merge** commit as the
release identity:

```bash
git checkout main
git pull --ff-only
RELEASE_SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$CANDIDATE_SHA" "$RELEASE_SHA"
printf 'candidate: %s\nrelease: %s\n' "$CANDIDATE_SHA" "$RELEASE_SHA"
```

The ancestry command must exit 0. From this point onward, migrations, worker,
API and mobile release evidence refer to `RELEASE_SHA`, not the pre-merge branch
head. This avoids a subtle release split when GitHub creates a merge commit.

---

## 4. Capture the live migration ledger and derive the target

Never infer the live schema from the Git branch, an old release note, or this
runbook. Read it.

At the checked-out `RELEASE_SHA`:

```bash
for f in db/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  basename "$f"
done | LC_ALL=C sort > release-migrations.txt

TARGET_MIGRATION="$(tail -n 1 release-migrations.txt)"
TARGET_COUNT="$(wc -l < release-migrations.txt | tr -d ' ')"

psql "$DATABASE_URL" -Atc \
  'SELECT filename FROM schema_migrations ORDER BY filename' \
  > pre-release-ledger-names.txt

psql "$DATABASE_URL" -Atc \
  "SELECT filename || '|' || checksum FROM schema_migrations ORDER BY filename" \
  > pre-release-ledger-checksums.txt

comm -23 release-migrations.txt pre-release-ledger-names.txt \
  > pending-migrations.txt
comm -13 release-migrations.txt pre-release-ledger-names.txt \
  > unexpected-production-migrations.txt

PENDING_COUNT="$(wc -l < pending-migrations.txt | tr -d ' ')"
LIVE_LATEST="$(tail -n 1 pre-release-ledger-names.txt)"

printf 'live latest: %s\ntarget: %s\npending: %s\n' \
  "$LIVE_LATEST" "$TARGET_MIGRATION" "$PENDING_COUNT"
```

Required checks before proceeding:

- `unexpected-production-migrations.txt` is empty. If production contains a
  migration filename the release artefact does not know, **stop**.
- Every live migration is an ordered prefix/subset consistent with the release
  artefact. Gaps or divergent history are a blocker.
- `pending-migrations.txt` is the exact list to review, rehearse and later apply.
- Keep `pre-release-ledger-checksums.txt` with the release record. The migration
  runner also refuses an already-applied migration whose checksum changed.

A zero pending count is valid. It means the schema is already at the release
artefact; it does **not** permit skipping the remaining release checks.

---

## 5. Backup and preflight

Confirm the backup/restore point recorded in the preconditions exists for the
same database host used above.

Then run the non-mutating migration preflight:

```bash
DATABASE_URL='…' \
DAWAEE_APP_PASSWORD='…' \
DAWAEE_WORKER_PASSWORD='…' \
./scripts/migrate.sh --preflight-only
```

Expected: exit 0 and `preflight complete — no migration was applied`.

Any non-zero exit is a release stop. Do not apply migrations first and diagnose
permissions later. See `docs/RUNBOOK-migrate-preflight.md`.

---

## 6. Rehearse the exact pending upgrade on a production-shaped copy

Restore the fresh production backup into a scratch database owned by a role
with `rolsuper = false` and `rolbypassrls = false`.

Use the **same `RELEASE_SHA`** and run:

```bash
DATABASE_URL="postgres://…/scratch" ./scripts/migrate.sh \
  | tee scratch-migrate-first.log
DATABASE_URL="postgres://…/scratch" ./scripts/migrate.sh \
  | tee scratch-migrate-second.log
psql "postgres://…/scratch" -f db/seed/rls_probe.sql \
  | tee scratch-rls.log
```

Verify:

- The first run applies exactly the files represented by
  `pending-migrations.txt` from the restored production baseline.
- The resulting scratch ledger ends exactly at `TARGET_MIGRATION` and contains
  exactly `TARGET_COUNT` release migrations.
- The second run prints `no pending migrations`.
- The RLS probe has no `FAIL`.
- No migration or integrity assertion fails.

The repository CI also carries a production-shaped upgrade rehearsal from its
known test baseline to current head. That is regression evidence; the restored
production copy above is still the release authority because the live ledger may
have moved since the CI baseline was created.

If any result differs, stop. Do not adjust the expected count by hand merely to
make the rehearsal pass.

---

## 7. Review every pending migration before production

Do not carry forward blanket claims such as “all pending migrations are
additive.” The pending set changes over time.

For each filename in `pending-migrations.txt`, review and record:

- DDL (`CREATE`, `ALTER`, `DROP`, constraints, indexes, triggers/functions)
- DML (`INSERT`, `UPDATE`, `DELETE`)
- table-lock / index-build implications
- backfill volume and runtime
- whether old code can safely run against the post-migration schema
- rollback consequence if the file succeeds and code deployment later fails

If the review finds destructive or long-locking behaviour not exercised by the
scratch rehearsal, stop and create a release-specific migration plan.

---

## 8. Apply production migrations deliberately

With the production backup verified and `RELEASE_SHA` checked out:

```bash
git checkout "$RELEASE_SHA"
./scripts/migrate.sh 2>&1 | tee "migrate-$(date +%s).log"
```

Expected:

- If `PENDING_COUNT` was greater than zero, the applied count and filenames
  match the reviewed pending set.
- If `PENDING_COUNT` was zero, the runner prints `no pending migrations`.
- The runner ends with `migrations complete`.
- A second run is a no-op.
- The live ledger now ends at `TARGET_MIGRATION` with no unknown entries.

Any failure: stop. Do not retry blindly. Compare the live ledger to the scratch
result and use the backup only if code rollback cannot restore safe operation.

---

## 9. Deploy and verify the worker first

Deploy canonical `dawaee-worker` manually at `RELEASE_SHA`.

Required evidence:

- pre-deploy migration run is a no-op and ends successfully;
- worker reaches live on `RELEASE_SHA`;
- regular ticks continue;
- `materialize` succeeds;
- the pre-release production error
  `permission denied for table dose_occurrences` no longer appears;
- no new permission error appears in another worker job;
- job/run errors remain sanitized and contain no patient data.

Observe multiple ticks, not just process startup.

Rollback condition: pre-deploy failure, crash loop, materializer still failing,
or a new worker-wide regression → rollback to `PRE_RELEASE_WORKER_DEPLOY` and
stop. Do not move the API forward.

---

## 10. Deploy and verify the API

Deploy canonical `dawaee-api` manually at the **same** `RELEASE_SHA`.

Before declaring it live, verify the Render service itself reflects the intended
release configuration. In particular, the release candidate expects the
readiness endpoint to be the traffic gate and must not rely on a sleeping free
service for medication actions/reminders.

Probe:

```bash
curl -fsS https://<api-host>/health
curl -fsS https://<api-host>/health/ready
curl -fsS https://<api-host>/version
```

Required evidence:

- `/health` is 200;
- `/health/ready` is 200 and reports the required database/schema/worker/provider
  checks ready;
- `/version` reports `RELEASE_SHA` and the release schema target;
- API and worker build identities agree;
- no cold-start 503 pattern appears after the intended non-sleeping service
  configuration is active;
- production Render request logs for fixed-path traffic contain **no stable
  profile, medication, dose, schedule, upload-object or caregiver relationship
  identifiers in paths or queries**.

That last item is the closure criterion for the open Render platform request-log
privacy blocker. Application logger redaction alone is insufficient.

Rollback condition: readiness failure, wrong SHA/schema, crash loop, global auth
failure, persistent 503 availability problem, or identifier-bearing platform
URLs after the supposed cutover → rollback to `PRE_RELEASE_API_DEPLOY`; if the
worker/API contract is no longer coherent, also rollback the worker.

---

## 11. Production smoke tests with synthetic accounts only

Use dedicated synthetic accounts. Never use a real patient account for release
verification.

1. Register/sign in with the supported password flow.
2. Confirm `/v1/auth/otp/request` fails closed with the documented
   provider-unavailable response if OTP remains intentionally disabled; do not
   require a successful OTP while no approved delivery provider exists.
3. Create a patient profile.
4. Create a medication, schedule and stock record.
5. Verify the expected dose occurrences exist and the worker extends the rolling
   materialization horizon.
6. Confirm Taken, Skip and Snooze boundaries and idempotent replay behaviour.
7. Read the patient/profile resources from an unrelated account and prove no
   cross-tenant data is returned.
8. Exercise caregiver invitation, least-privilege reads, dose confirmation and
   permission revocation; revoked permissions must take effect immediately.
9. Exercise upload → PUT → finalize → OCR/read with synthetic non-sensitive
   content; cross-profile/object replay must fail.
10. Check notification privacy defaults and a retry after a privacy/permission
    change.
11. Exercise offline/replay reconciliation from a test device/build where
    available.
12. Verify admin access with a synthetic admin, then remove `is_admin` in the
    controlled operator path and prove the already-issued token loses privileged
    access on the next admin request.

Cross-tenant data exposure, stale revoked privilege, or a dose/stock replay that
changes clinical state twice is an immediate release stop and incident-level
finding.

Delete synthetic test data after verification.

---

## 12. Native release gates

The mobile app must not ship ahead of the verified API contract.

Before store submission:

```bash
cd apps/mobile
npm ci --legacy-peer-deps
npx tsc --noEmit
npx expo-doctor
eas build --platform ios --profile production
eas build --platform android --profile production
```

Then test on physical iOS and Android devices:

- notification permission granted and denied;
- reminder delivery with the app closed;
- lock-screen notification privacy default and explicit opt-in behaviour;
- offline reminder/action and reconnect reconciliation;
- secure token and invite-capability storage;
- Arabic RTL layouts;
- timezone/travel behaviour;
- Emergency QR limited disclosure and capability transport;
- account/profile switching with no stale cached clinical data.

A hardware/OS behaviour that was not observed is `NOT RUN`, not PASS.

Use staged/phased store rollout and halt it on crash or reminder-delivery
regression.

---

## 13. Auto-deploy decision after release

Do not automatically re-enable deploy-on-commit merely because the release is
green. Record an explicit decision.

If canonical API/worker auto-deploy is re-enabled, document how a future
migration-bearing release is ordered so API code cannot outrun the worker's
pre-deploy migration. A Blueprint sync may re-assert `render.yaml`, so verify the
actual Render service state after any sync.

Leave the four duplicate fail-closed services out of the release path. Their
cleanup remains governed by `docs/RENDER-CLEANUP-RUNBOOK.md`.

---

# Rollback plan

## R1 — Worker

Rollback the canonical worker to the recorded `PRE_RELEASE_WORKER_DEPLOY`.
Confirm it reaches live and resumes its pre-release observable behaviour.

## R2 — API

Rollback the canonical API to the recorded `PRE_RELEASE_API_DEPLOY`. Confirm
`/health` and the pre-release supported user flow recover.

## R3 — Schema restore, only when code rollback is insufficient

There are no generic down-migrations. Schema rollback means restoring the
verified pre-release backup and therefore losing writes after that backup.

Require:

- the specific failure that R1/R2 cannot solve;
- explicit second-operator authorization;
- the exact data-loss window;
- a written incident/recovery record.

Do not restore merely to make schema and code versions look cosmetically equal.

---

# Release evidence to retain

Keep together:

- `CANDIDATE_SHA` and post-merge `RELEASE_SHA`;
- PR and required-check results;
- GitHub ruleset snapshot/reference;
- pre-release API/worker deploy IDs and SHAs;
- backup identifier/timestamp;
- `release-migrations.txt`;
- `pre-release-ledger-names.txt`;
- `pre-release-ledger-checksums.txt`;
- `pending-migrations.txt`;
- preflight output;
- scratch rehearsal logs;
- production migration log;
- worker verification logs;
- `/health`, `/health/ready`, `/version` results;
- redacted Render platform-log evidence proving fixed-path privacy cutover;
- production smoke-test record;
- physical-device test record for any mobile release.

---

# What remains external / cannot be inferred from green CI

- The live production migration ledger until it is read in Step 4.
- Existence and restorability of the current Supabase backup.
- Provider credentials and real push/OCR/storage delivery until readiness and
  end-to-end provider checks are observed.
- Physical-device notification/background behaviour until tested on hardware.
- Store acceptance and staged rollout behaviour.
- Legal/retention-policy approval; technical controls are not a compliance
  opinion.

A green repository is necessary evidence, not permission to skip these release
checks.
