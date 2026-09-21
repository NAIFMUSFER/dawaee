# F5 — transactional account-email capacity

Registration bypassed the common recipient cooldown and daily sending budget.
Unknown recovery recipients consumed global capacity despite creating no job.
The independent PGlite/Fastify reproduction failed both cases before changes:
five immediate registration jobs and six no-op recovery capacity charges.

Registration now shares the email IP, recipient and hourly attempt budgets.
Registration, recovery and authenticated verification enqueue inside a savepoint
and reserve global capacity only when their new token has a pending mail job.
Denied capacity rolls back that job and its capacity increment together, keeping
an earlier reset/verification link intact. Attempt budgets remain committed.
Anonymous responses stay identical (202), including at global exhaustion;
authenticated verification returns 429 after its transaction finishes.

Migration 0097 adds a boolean-only definer function keyed by a fresh random
token hash. It grants neither private queue reads nor worker execution. Existing
numbered migrations and request function signatures are unchanged.

Validation on Node 22.23.2:
- Before: independent F5 reproduction, 2 failed tests (4 failed assertions).
- After: 18/18 cases across the reproduction and HTTP boundary suite; real SQL,
  forced RLS, non-superuser owner, saturated capacity, preserved prior reset,
  uniform responses and runtime role restrictions included.
- Workspace TypeScript build, changed-file ESLint and diff check passed.
- Added a native PostgreSQL two-replica final-slot race in shared-rate-limit;
  native execution awaits CI because this local environment has no psql.

PGlite is a single connection and is not concurrency evidence. No real mail,
hosted account/database write or deployment occurred. Migration 0097 and its API
code must roll out together; deploy migrations before starting the new API.
Provider delivery retries are bounded separately and are not extra API jobs.
