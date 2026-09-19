# Operations

Use the [production release runbook](PRODUCTION-RELEASE-RUNBOOK.md) for migration,
release and recovery steps. `render.yaml` is the infrastructure declaration;
the live service settings and exact candidate SHA must also be verified. A
historical successful deployment is not approval for a new schema or binary.

## Local development

`docker compose up --build` starts PostgreSQL, a one-shot migration service,
the API and the worker. The migration service runs the normal ledger under a
separate schema owner. The API and worker wait for successful migration and use
their own restricted roles. Existing databases with an unexpected owner or
schema are refused; do not delete a volume merely to bypass that refusal.

## Health and delivery diagnosis

- `/health` is liveness; use it for the service's continuous health check.
- `/version` identifies the running commit and required schema revision.
- `/health/ready` is the release gate for database/schema/provider readiness and
  worker health/build agreement. Its normal public payload is intentionally minimal.
- The permission-gated admin endpoints expose operational job and delivery
  failures. Keep patient names, medication data, tokens and secret values out
  of incident reports.

For a missing reminder, establish the affected schedule timezone and dose state,
then inspect materialization, reminder creation, dispatch, provider ticket and
receipt. Check native permission/token registration and local scheduling
separately. Provider acceptance is not handset display. The push receipt job
retires a matching dead token without disabling a replacement token.

## Worker coordination

Jobs use database coordination and dispatch leases. Before sending, dose
reminders recheck current eligibility and ownership; retries can still duplicate
an externally accepted message after an ambiguous network result. Quiet-hour
and snooze intent, pause state, completed doses and stock refills affect pending
messages. Scaling or concurrent-connection behavior requires the actual
PostgreSQL gate; an in-process simulation does not prove it.

## Migrations and recovery

Use `scripts/migrate.sh` and the
[migration preflight runbook](RUNBOOK-migrate-preflight.md). Do not edit applied
migration contents, bypass their checksums, or grant the runtime owner rights.
Record the live ledger, candidate schema and a compatible recovery target.
Forward-only migration history does not imply every older runtime is compatible.
Verify backup/restore evidence for the real production database at release time;
a per-patient JSON export is not a database backup.

## Audit preview

The existing isolated preview uses `scripts/audit-preview-start.mjs --apply`.
Its service, origin, database identity and least-privilege roles are explicitly
checked; unknown partial schemas are refused. It preserves its ledger and data
and runs mock providers with synthetic records. Its successes cannot establish
real SMS/email/APNs delivery or approve a production release.
