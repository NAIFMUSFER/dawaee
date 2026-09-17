# PR #25 — synthetic recovery rehearsal and production fallback

Production release remains blocked. This procedure proposes coordinated restore
of the pre-upgrade database with its matching API/worker as the fallback for the
recorded baseline. It does not authorize production restore or establish a
zero-loss recovery point.

A subsequent [rebuilt-runtime CI rehearsal](2026-09-14-runtime-recovery.md)
executes the complete pinned API/worker processes through real HTTP and their
normal worker loop. Its image IDs and final job result are separate evidence;
the SQL-only experiment below remains useful on both PostgreSQL majors.

The recorded API is `4cf23531dfaa5cc7c3790b473f8b4ff9f88d9f72`; the recorded
worker is `0338ddefc475d23cccecf13d5ede0f32d2007fb0`. Migration 0037 removes the
unique conflict target used by their old stock SQL. Migration 0039 removes the
worker's direct stored-object access. Returning to these deploy IDs on schema
0080 therefore does not provide the fallback the previous plan assumed.
Reintroducing the old uniqueness rule would lose legitimate take/undo/re-take
ledger entries; broadening worker grants would discard its intended boundary.

## Repeatable CI experiment

With the normal local/CI test PostgreSQL and ordinary roles prepared, run:

```bash
npx vitest run apps/api/test/release-recovery-environment.test.ts \
  apps/api/test/production-recovery-rehearsal.test.ts
```

The root CI already invokes both through `npm test` on PostgreSQL 16 and 17,
with a matching PostgreSQL client. The release-suite manifest requires them.
The helper accepts only `NODE_ENV=test`, loopback port 5433, an empty `postgres`
control database and the established ordinary CI roles. It creates randomly
named targets, never takes a target URL, refuses restoring over a populated
target or its source, and drops only databases it successfully created. It
never rotates shared role passwords. Test archives and synthetic object bytes
are temporary and are removed in cleanup.

| Stage | Assertion |
| --- | --- |
| Baseline | Real runner applies unchanged 0001–0033 + 0047; 34 ledger rows; populated stock, doses, events and two object tickets |
| Backup | Whole synthetic database exported with `pg_dump --format=custom`; artifact SHA-256, byte length and elapsed milliseconds recorded |
| First restore | Fresh target restored in one transaction as NOSUPERUSER/NOBYPASSRLS owner, preserving ACLs and policy grantees |
| Exact comparison | All public/app table rows (including ledger) and sequence states; table owners/RLS/grants, policies, app functions/grants, indexes and constraints match |
| Upgrade | Real runner reaches every required migration/checksum, currently 80; a second run reports no pending migrations and leaves the compared state unchanged |
| Current API service | Runtime app role runs take → undo → take → replay; balance moves 29 → 28 → 29 → 28, four stock rows sum to −2, three new moves identify distinct events |
| Current worker | Runtime worker runs real housekeeping; local provider removes abandoned bytes and metadata, retains referenced bytes and metadata, and reports no failed steps |
| Old SQL contracts | Non-executing `EXPLAIN` succeeds on baseline, fails after upgrade with the expected stock/privilege errors, succeeds on restored baseline |
| Recovery restore | Original archive restored into another fresh target; comparisons run before migration/maintenance can mask a defect; current schema checker correctly rejects this old ledger |
| Recovery limits | A source write after backup and candidate dose writes are absent after recovery; an abandoned object ticket returns but its deleted external bytes do not |

`SYNTHETIC RECOVERY REHEARSAL PASSED` is printed only after these assertions.
Its JSON contains the digest, counts and local timings, with explicit false
flags for production backup, full old-binary execution, restored object bytes
and recovered post-backup writes. Attach the exact commit and both successful
matrix job logs to the release evidence. Milliseconds on tiny fixtures are not
a production RTO estimate. SQL planning is not proof of old application startup,
authentication, full worker scheduling or device behavior.

The administrator reads this synthetic dump to cover FORCE RLS tables; restore
runs as the ordinary schema owner using `--no-owner`, without dropping ACLs or
disabling triggers. Production role mapping must be separately rehearsed:
the recorded owner is `dawaee_owner`, not the CI role `dawaee_migrator`.
Database dumps do not contain cluster-global roles; keep role setup and secrets
in their approved recovery channel. See the official
[pg_dump documentation](https://www.postgresql.org/docs/17/app-pgdump.html) and
[pg_restore options](https://www.postgresql.org/docs/17/app-pgrestore.html).

## Production maintenance and recovery sequence

This is a proposed procedure awaiting the actual production backup, isolated
restore evidence, agreed RPO/RTO and the release runbook's operator gates.

1. Record the selected candidate SHA, actual live API/worker image identities,
   production ledger/checksums and project identity. Recheck them immediately
   before the window. Disable automatic deploy and block traffic to any service
   connected to the recovery copy; rehearse that control before the window.
2. Inventory and pause every writer: API mutations, worker ticks, scheduled
   jobs, webhooks and direct administrative automation. Confirm database write
   quiescence and in-flight transaction completion. A generic health endpoint
   cannot establish this. Define how queued offline dose intents are held and
   reconciled during reopening; a restored ledger can forget their idempotency
   identities, so do not blindly replay previously acknowledged actions.
3. After quiescence, take and verify the pre-upgrade database restore point.
   Record UTC cutoff, digest/backup identifier and every covered schema. Verify
   object bytes/versioning separately, including erasure and metadata references.
   Prove restore duration and role mapping on an isolated production-derived
   target. Keep dumps out of source control and public CI logs.
4. Upgrade that copy using the exact candidate. Verify all pending MD5s, the
   second-run no-op, integrity checks, RLS and the current app/worker flows.
   Exercise the exact pre-release binaries as well, recording their known
   incompatibilities and their behavior on the recovered baseline. Test auth,
   stock, reminders and housekeeping; do not infer them from SQL planning.
5. Only with the production gates approved, keep writers paused while applying
   the release. Start the matching candidate pair and complete the runbook's
   acceptance checks before reopening writes. Capture any deliberate smoke-test
   mutations within the recorded recovery window.
6. If coordinated restore is required, obtain the required second-operator
   authorization and record the incident and affected write window. Stop both
   candidate runtimes, restore the verified point into the approved target,
   restore/reconcile object versions, and verify original ledger, data and
   ordinary-role permissions before attaching services.
7. Restore only the matching pre-release API/worker pair. Rehearse how Render's
   selected rollback/deploy mechanism treats pre-deploy hooks; ensure it cannot
   reapply pending migrations to the recovered database. Keep target isolation
   and write restrictions until old-version startup and user/worker flows pass.
   Account for secret/connection changes, queued notifications and offline intents
   before deliberately reopening traffic. Record actual RPO and RTO.

No production backup or object archive has been obtained by this experiment.
No production service is paused, redeployed or reconfigured. The required
Android/iPhone and real push-delivery acceptance tests remain outstanding.
