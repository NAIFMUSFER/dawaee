# F16 — preserve healthy schedules when one selected schedule fails

Base candidate: `c555cd576ea517579d735cd6bf0ddaa612cc0946`.
Verdict: **partially confirmed**. The independent source verification and
hosted read-only evidence preceded this repair on
`audit/independent-verification-20260921`.

## Evidence before the repair

The committed PGlite reproduction executes the real worker, real SQL and all
numbered migrations, with the worker role and forced RLS. A persisted malformed
rule (`times: [null]`) satisfies the existing database constraints, although the
public API rejects it. After 14 healthy doses are inserted, processing that rule
throws and `runJob` rolls back every schedule: zero healthy doses remain.

A second reproduction injects an actual SQL division-by-zero after the broken
schedule's inserts, at its horizon update. The earlier healthy schedule is lost
and the later healthy schedule never runs. Merely catching the error cannot
recover PostgreSQL's aborted transaction. Before runtime changes these two
cases fail; the housekeeping counterexample passes. Housekeeping already uses
savepoints and commits later work after the same real SQL error, while recording
a failed step. It is not changed.

## Change

Each selected schedule runs inside a savepoint. Successful work counts only
after release. On an item error, rollback to that savepoint removes all of that
schedule's inserts and horizon changes; later schedules continue. Failed
rollback/release is not swallowed and still aborts the outer job.

The existing `runJob` partial-failure contract commits healthy work but records
`succeeded = false`, the committed item count and a sanitized `failedSteps`
entry. No patient, medication or schedule identifiers, rule content, raw error
message or stack are added to operational metadata. The failing row stays
eligible for the next tick. No schema, grant, request budget or provider changes
are involved.

## Validation and limits

The three PGlite cases pass after the repair: healthy 14 versus broken 0 in the
malformed-rule case, and healthy 14 + 14 versus broken 0 after a real SQL error.
The separate native PostgreSQL test also requires earlier and later work to
commit, then removes its synthetic error and requires exactly 14 newly created
doses with no duplicates. CI must execute it on PostgreSQL 16 and 17; the local
environment has no native PostgreSQL server or client.

Full Vitest, ESLint, server/mobile typechecks, RLS probes, twice-applied clean
migrations and all security workflows must pass on the published PR head before
integration. Final run IDs and exact counts belong in the PR and audit record.
No existing rejection control, timeout, schema constraint or CI gate is relaxed.

This proves isolation for selected schedules during materialization, not every
worker job or errors in the initial selection query. It does not establish
fairness if a complete batch consists of corrupt schedules. Those cases require
their own evidence before a broader repair. PGlite is not evidence of native
concurrency or device behavior; the PostgreSQL integration case supplies the
native transaction check.

## Deployment and rollback

The mobile/API contract is unchanged. Rollback is to the previously verified
worker/API pair, worker first; the already committed dose rows remain and the
existing unique constraint prevents duplicate materialization. No data cleanup
or schema rollback is needed for this item. The inherited migration 0096 from
F1 still requires the complete migration and production-backup gates if this
candidate is eventually deployed.

Neither preview nor production is deployed by this repair. The separately
documented N26 preview bootstrap boundary must be resolved without changing
secrets before deployment. A written rollback plan is not a completed preview
rollback drill. No hosted patient data was changed and no provider was called
to exercise these synthetic fixtures.
