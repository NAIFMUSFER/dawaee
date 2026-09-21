# F19 — retire unreviewed HTTP acceptance

Both legacy acceptance routes could activate a care relationship without the
role/permission set the current client requires the recipient to review.
They now validate the request and return the same authenticated 409 refusal,
with Arabic/English instructions to update and review. They neither inspect
nor consume the invitation. The existing preview and reviewed-accept endpoints
retain recipient binding, live verification, expiry and locked grant comparison.

Clinical fixtures now explicitly preview and submit that shown grant; their
authorization, expiry and revocation assertions are retained. Retried acceptance
uses the same previously reviewed request, not an automatically refreshed grant.
No source migration was rewritten. The existing internal SQL acceptance function
remains necessary to the reviewed definer function; this repair closes HTTP entry
points, not arbitrary direct access by the trusted database application role.

Validation:
- Before: both legacy routes returned 200 in the new SQL/HTTP reproduction;
  2 failed / 1 passed.
- After: 7/7 real PGlite SQL/RLS cases, including no mutation on legacy refusal,
  uniform account responses, changed grants, current-recipient retry, revocation,
  direct wrong-recipient/unverified/expired/archived refusal.
- Workspace TypeScript build, changed-file ESLint and diff check passed.
- Native clinical/security fixture suites await full PostgreSQL CI; psql is
  unavailable locally. No device, invitation delivery or deployment is claimed.

Rollout implication: older installed clients cannot accept through the retired
routes. Their request gets an explicit update/review message. General legacy
registration contract F4 is a separate repair.

CI follow-up: both PostgreSQL 16 and 17 passed 2,948 of 2,949 tests, exposing
one source assertion that still expected the retired token-only route. It now
checks the current preview/reviewed-accept contract. Added real SQL cases for
self and missing invitations so the behavior is covered independently of that
source assertion. The focused follow-up passed 12/12 tests (9 SQL/HTTP and
3 mobile), with changed-file ESLint and diff checks passing. Native CI will be
rerun on the combined candidate before integration.
