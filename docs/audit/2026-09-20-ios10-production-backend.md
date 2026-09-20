# Build 10 backend incident and production update — 20 September 2026

## Report and established cause

The owner reported that the backend did not respond in iOS build 10. At
19:17 UTC the public production health and readiness endpoints returned 200,
but `/version` still identified `63b5b8d` and schema 0088. The reviewed build 10
uses `e59f864a6ae32ec28276b1b786e64b0621506308` and the email-only registration
contract requiring schema 0095. This deployment mismatch was verified; a
general outage or the precise failure on the owner's device was not reproduced.

The archived build-10 IPA's `Payload/TADAWEE.app/main.jsbundle` contains
`https://dawaee-api.onrender.com` and does not contain the audit-preview origin.
Production login logs contained `invalid_credentials` / 401 at 19:12–19:13 UTC.
These logs were not attributed to a particular person. Read-only inventory
found zero active production accounts and eleven already retired rows. An
account created in the separate preview cannot sign in to production.

## Reviewed before deployment

- PR #32 remained open/draft at exact source `e59f864`; the local tracked tree
  had no unpublished application edits. Existing dependency symlinks remained.
- [CI 35527946265](https://github.com/NAIFMUSFER/dawaee/actions/runs/35527946265)
  and [Security 35527945996](https://github.com/NAIFMUSFER/dawaee/actions/runs/35527945996)
  were completed/success. The identical source had already been deployed and
  inspected in the isolated preview. These checks are not native acceptance.
- Both production services had automatic deploy disabled and no active deploy.
  Pending migrations 0089–0095 and the worker's normal migration entry point
  were reviewed. No migration file or account-reset script was edited.
- A read-only transaction under `dawaee_owner` checked role containment,
  separated ADMIN grants, RLS enablement/ownership, absence of attached release
  backup schemas and definer-policy coverage. It found 88 ledger entries and
  zero missing definer policies. Ordered filename/checksum ledger MD5
  `e52f91e2c18dfc7bb4f5b08dd62463ab` matched the repository's 0088 baseline.
- This incident did not create a new production backup or perform a fresh
  production-derived restore rehearsal. Existing CI recovery results remain
  synthetic evidence; no new recovery-point or zero-loss guarantee is claimed.

## Actually deployed

| Component | Deployment | Source | Result (UTC) |
|---|---|---|---|
| Worker | `dep-dao35lo473hc73b8rs30` | `e59f864` | Started 19:24:07; live 19:26:18 |
| API | `dep-dao37c3m8hqs73d3pqgg` | `e59f864` | Started 19:27:44; live 19:29:44 |

The worker's normal `./scripts/migrate.sh` pre-deploy completed at 19:26:07
and applied all seven pending migrations. The resulting 95-entry ledger MD5
is `dfff424c087fe4704ff7c7c8cbb5e66b`, identical to the candidate files.
There are now 33 forced-RLS application tables and none with FORCE enabled
while RLS is disabled. The eleven retired account rows were retained; there
were still zero active accounts and no registration challenges after migration.

The first worker tick logged a database authentication failure at 19:26:17.
The next normal tick recovered without a configuration or credential change:
all eight jobs succeeded at 19:27:17–18 on `e59f864`, including housekeeping
and push receipts. Later ticks also succeeded. The API was deployed only
after this recovery was independently verified in `job_runs`.

## Verified after deployment

- At 19:30:16 UTC, `/version` returned `e59f864` and
  `0095_verified_email_registration.sql`; `/health/ready` returned HTTP 200
  with `status: ready`. The email recovery options endpoint returned 200,
  `provider: email`, `available: true`.
- The real production browser initially showed the old name/phone/email/password
  form. Reloading after deployment visibly showed the new email-only form,
  the same-invitation-email guidance and disabled submission while empty.
  Its button opened the new sign-in screen with the password-recovery action.
  The recovery action loaded the email form and a disabled send button while
  empty. This is rendered production UI evidence, not a login, successful
  registration or delivered recovery email.
- Production API/worker error/fatal logs from 19:29:44 through 19:30:39 were
  empty. Readiness and normal worker execution were checked separately.
- Automatic approval review rejected a proposed synthetic production
  registration POST before execution because prior synthetic-account permission
  was scoped to the test environment. It would create a registration challenge
  and send mail. The request was not retried through the browser or another
  route; no production test account or email was created in this run. Actual
  production registration completion/login remains unverified here.

## Remaining and scope

The verified backend mismatch is corrected. The owner should retry build 10;
if the earlier account was created in the preview, production registration is
separate. Do not repeat the old account reset, restore retired identifiers or
delete new accounts. Any remaining device error needs its actual screen/step.

Apple processing completion was independently verified at 19:12 UTC in the
previous checkpoint. This run made no new native build/upload, changed no
tester groups, merged no PR and submitted no public App Store release. A later
Apple read at 19:27 reached sign-in, so tester distribution was not reverified.
Physical iPhone notifications, camera, and mounted-session revocation acceptance
remain separate from this backend update.
