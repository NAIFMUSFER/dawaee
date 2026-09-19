# Erasure readiness repair — 2026-09-19

Production account-reset verification found 23 failed housekeeping runs in the
preceding day. The latest failed steps were image cleanup with an unconfigured
storage provider. The API readiness check covered six frequent reminder jobs,
but not housekeeping. Successful reminders could therefore hide failed final
account erasure. An API with correctly configured storage also cannot establish
that its independently configured worker can delete images.

## Changes

- `/health/ready` now requires a successful housekeeping heartbeat from the same
  commit as the API. Hourly cleanup has a two-hour freshness budget; frequent
  reminder jobs keep their existing three-minute budget. Public responses still
  expose only generic failed checks. `/health` remains process liveness so a
  storage/configuration fault cannot make Render restart the serving API.
- The real worker entry point runs housekeeping during its first tick, then
  hourly by elapsed time. It no longer waits one hour after every restart.
  Skipping another worker's advisory lock does not postpone the next attempt.
  Connection failures can retry on the next tick; overlapping cleanup calls
  share the in-flight attempt. Database job locks remain the cross-process guard.
- Production housekeeping records a storage-configuration failure even when no
  abandoned objects or due accounts exist. Other retention steps continue with
  their existing savepoints. Existing erasure grace, private-storage deletion,
  RLS, audit guards and physical-bytes-before-metadata checks remain intact.

## Validation

Before the runtime edit, seven new regression cases failed: readiness returned
200 with failed/missing/stale/different-release cleanup; empty production queues
hid unavailable storage. After the repair, 64 focused tests in seven files
passed. These include actual PostgreSQL/WASM migrations and restricted worker
SQL for reminder/delivery retention, plus readiness privacy, liveness separation,
cleanup cadence and provider configuration. Workspace build/typecheck, changed
ESLint and diff checks passed. PostgreSQL 16/17 CI and rebuilt-container recovery
must pass for the published candidate; the PR checkpoint records their outcome.

## Operational work still required

This repair detects and reports the actual configuration fault; it does not
create storage credentials or prove physical image access. On both production
services, configure the same actual private bucket and provider:

| Setting | Required value |
| --- | --- |
| `STORAGE_PROVIDER` | Actual `s3` or `r2` provider |
| `STORAGE_BUCKET` | Existing private bucket holding the app objects |
| `STORAGE_ENDPOINT` | Correct provider endpoint when using R2/custom S3 |
| `STORAGE_ACCESS_KEY_ID` | Credential restricted to this app's private bucket |
| `STORAGE_SECRET_ACCESS_KEY` | Corresponding secret, entered only in service settings |
| `STORAGE_REGION` | Actual S3 region, or `auto` for R2 |

Confirm real read/upload/delete behavior with a synthetic object, then confirm
successful housekeeping and matching API/worker release readiness. Do not delete
the eight retained metadata rows to hide an object-storage failure. Their bytes
were not included in the account recovery snapshot and their existence remains
unverified. The existing reset markers become eligible on October 3; they must
not be backdated, replayed or confused with completed hard erasure.

The cloud browser still failed CDP tab refresh on this continuation. The Render
preview database connector previously failed TLS/EOF; preview accounts have not
been reset. Patient/caregiver/nurse interface acceptance and physical iOS trials
remain open. No final build, production cutover or store submission is authorized
by an automated-test result alone.
