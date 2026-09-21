# Restored readiness prerequisites — 2026-09-21

Base: `75a826b`. This reimplements the unavailable local `da8f53b` change.

Production readiness now requires a recent successful `push-receipts` heartbeat
from the API's exact commit, and complete account-email configuration using the
same predicate that gates registration and password recovery. Email readiness
is a configuration check, not a claim of mailbox delivery. No provider network
request is performed by the health route.

The Blueprint lists the five account-email settings as `sync: false`, without
keys, sender values or forced overrides. `/health` remains process liveness;
the stricter `/health/ready` remains the controlled release gate. Existing
worker-first cutover behavior and minimal public error responses are preserved.

Five new HTTP regressions failed before the source change: missing, stale,
failed and mismatched receipt processing, plus missing mandatory email setup.
The other 14 cases passed. After repair, 47 cases across readiness, error
privacy, deployment coherence and the email provider passed. Workspace
TypeScript, changed-file ESLint and diff checks passed. Full published-head
CI/security are still required before integration or deployment.

This establishes a readiness contract defect. It does not establish that these
conditions caused any specific production outage. No environment variables,
secrets, live provider calls, migrations or deployed services were changed.
