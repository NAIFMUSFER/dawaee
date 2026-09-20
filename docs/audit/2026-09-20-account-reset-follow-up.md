# Account reset follow-up — 2026-09-20

## Authorization and scope

The owner explicitly expanded the request to **all accounts, including new
accounts through today**. This supersedes the earlier instruction to protect
post-September-19 registrations. It does not authorize resetting unrelated
projects or adding a recurring startup reset. The isolated preview is still a
separate database and must not be reported as cleaned based on production work.

## Production: executed and independently verified

Inventory at **09:09:51.718313 UTC** found eleven retained application rows:
ten already retired by the September 19 operation and one later account with
a pending deletion request. There were no Supabase Auth users. The later account
still occupied its identifiers and retained a password credential. Its existing
deletion request was dated September 19; it was not an active-account count of
one. The correct pre-operation count was one **non-disabled** account.

The one-account identity fingerprint was
`1d95f0f643b3ecdac5a0389bd1a87abb9b93b78fd41e8f88df38659326c296fa`.
An AES-256 encrypted logical snapshot covering thirty application tables was
saved outside Git with its recovery key. Independent local decryption and JSON
parsing matched the plaintext SHA-256
`aa6ce814d0ff380e67e7c3e0a8385749af9209409b5283e70f62049d2617d91a`.
Nine tables had a row, including one stored-object metadata row. Object bytes,
audit/job/provider logs and a full database re-import were not backed up or
tested by this snapshot.

`scripts/ops/reset-accounts-20260920-production.sql` was rehearsed with ROLLBACK.
All in-transaction assertions passed. A separate query confirmed the account,
credential and absence of the new audit marker were unchanged. The same bounded
transaction was then committed at **09:14:46.281506 UTC**. The script defaults to
ROLLBACK, requires the reviewed operator database/user, checks the exact identity
fingerprint and count, obtains the existing worker/auth locks, and refuses replay
after `owner-account-reset-20260920-production` is recorded.

This operation disabled the remaining account, freed its original email/phone,
removed its password and verification/recovery capabilities, revoked sessions
and care access, and archived the patient profile. Existing deletion timestamps
were preserved with `coalesce`, so the earlier ten accounts and their deletion
windows were not reset. No trigger, RLS policy or retention boundary was removed.

Independent post-commit verification at **09:15:08.218401 UTC** found:

| Check | Count |
| --- | ---: |
| Non-disabled accounts | 0 |
| Original contact identifiers retained by accounts | 0 |
| Password credentials / unrevoked sessions | 0 / 0 |
| Active push endpoints / patient profiles / schedules | 0 / 0 / 0 |
| Usable care links / emergency QR capabilities | 0 / 0 |
| Email challenges / queued or sending notifications | 0 / 0 |
| New reset audit marker | 1 |
| Migration ledger / retained object metadata | 88 / 7 |

This is immediate account retirement and identifier release, **not completed
physical erasure**. The existing deletion timestamp makes the additional account
eligible at **2026-10-03 19:57:09.371659 UTC**. The existing worker still owns
physical erasure, including object-byte handling; this run does not certify
successful future erasure. The original ten accounts remain on their original
schedule. See the [original reset evidence](2026-09-19-account-registration-reset.md).

## Preview: current execution follow-up

See the current result below; the following dated access attempts are historical.

### Confirmed upgrade and preview inventory — 2026-09-20

The owner completed the temporary preview upgrade in the dashboard. Independent
service reads report `0.5c-512mb`; deploy `dep-danr5op42hec73felm00` of the same
preview app commit `10eac842fd06ac0be54fd5a70caae3f78f8a8e06` became live at
10:20:16.720006 UTC. No new service or application code deployment was requested
for the reset. This resolves the earlier plan-change/access blocker.

Read-only job `job-danr7eugekts739t5neg` succeeded, fixing the inventory cutoff at
**10:22:25.790051 UTC**: 28 non-disabled accounts, 36 unrevoked sessions,
28 profiles, 3 stored-object metadata rows, 95 migrations, and 5 registration
challenges. The account-set SHA-256 is
`b5ad82b0ecb739f1e590c1c454d13e78801800df0eab7c20be9a6b93c83ba381`.

Automatic approval review rejected an encrypted backup-through-job-logs attempt
and a provider export-list attempt before execution. No preview backup or export
was created. The owner then explicitly stated that old account data is not needed.
The reset proceeds without a preview backup; do not request that approval again
or retry an export. Production evidence above is separate and unchanged.

The new preview-only SQL pins the exact database, owner, PostgreSQL major version,
account count/fingerprint, profile count, migrations and storage counts. It checks
worker/auth locks and active email leases, invalidates registration proofs added
in migration 0095, defaults to ROLLBACK and refuses replay after the audit marker.
No RLS, trigger, retention or date guard is disabled. The runner logs only aggregate
checks, verifies the SQL SHA-256, and reconnects for a read-only verification.

Rollback job `job-danrckuk1f9s739mhjo0` succeeded. The actual SQL passed every
assertion; a separate connection at **10:33:29.083207 UTC** confirmed all 28
accounts, 36 sessions, 28 credentials, 28 profiles, 19 active schedules, 2 usable
care links, and the five registration proofs remained. The reset audit marker
was absent. Thus the rehearsal did not retain any account change.

SQL SHA-256: `53d5670dd358126d6f00700311bbae0c380f02a7e65138159f4e9f9ea5d4b4ff`.

### Preview commit and independent verification — 2026-09-20

Commit job `job-danrdauk1f9s739mjm00` succeeded at 10:34:28 UTC. The reviewed SQL
committed at **10:34:25.187406 UTC**; a fresh connection verified its result at
**10:34:25.296898 UTC**. The transaction used the rehearsal SQL with only its final
ROLLBACK changed to COMMIT. The sole runner changes were correcting its header
and deadline label. No account rows, contacts, tokens or credentials were exported.

| Independent check for the 28 inventoried accounts | Count |
| --- | ---: |
| Non-disabled accounts / retained original identifiers | 0 / 0 |
| Unrevoked sessions / password credentials | 0 / 0 |
| Active push endpoints / profiles / medication schedules | 0 / 0 / 0 |
| Usable care links / emergency QR capabilities | 0 / 0 |
| Pending notification deliveries | 0 |
| Account-email / old registration proofs | 0 / 0 |
| Phone / email verification / onboarding / recovery proofs | 0 / 0 / 0 / 0 |
| Reset audit marker | 1 |
| Migration ledger / stored-object metadata | 95 / 3 |

The old email/phone identifiers are now free for new account UUIDs; existing
account sessions and emailed proof links cannot be reused. The marker is
`owner-account-reset-20260920-preview`. **Do not replay either reset.** Accounts
created after the fixed cutoff are outside the operation.

This is **immediate account retirement and identifier release**, not completed
physical erasure. The 28 disabled account rows and three stored-object metadata
rows remain subject to the existing worker's 14-day policy, with latest eligibility
**2026-10-04 10:34:24.822352 UTC**. Future physical erasure is not certified here.
No deletion timestamp was backdated. The owner declined a backup, which does not
change the app's existing database retention guards.

No new registration or email was sent in this operation. The user may retry
registration from the preview; actual delivery to the user's mailbox remains
unverified. A successful database cleanup is not a mail-delivery or UI acceptance.

### Restoring the temporary compute plan

All three one-off jobs finished successfully; no job is pending or running.
The official CLI attempt to restore the existing preview with `--plan free`
returned HTTP 500; a minimal REST PATCH for `serviceDetails.plan=free` returned
the same HTTP 500. An independent read still showed `0.5c-512mb`, last modified
at 10:20:16.721395 UTC. The cloud browser retry also failed before navigation:
`CDP operation refresh tabs timed out after 20000ms`.

Restoration is still required; **do not claim Free was restored**. No duplicate
service, deploy or job was created to work around this failure. The already
approved USD 1 ceiling remains in force. The owner can change the existing
preview's Instance Type to Free in its dashboard; this is an execution dependency,
not another request to approve cost or deletion.

Local checks: runner syntax, ESLint, and patch whitespace checks passed. The
actual preview transaction and fresh-connection checks above provide the reset
evidence. The prior draft head `18ae31e` separately passed
[CI](https://github.com/NAIFMUSFER/dawaee/actions/runs/35504587709) and
[Security scan](https://github.com/NAIFMUSFER/dawaee/actions/runs/35504587828).
Those completed checks do not cover the new operator files, native UI or iPhone
notification delivery. No application build, production deploy or TestFlight
submission was initiated by this follow-up.

### Earlier access attempts (superseded by the successful internal jobs)

### Temporary plan change authorized; provider error — 2026-09-20

The owner subsequently answered **yes** to temporarily upgrading the existing
preview service, completing cleanup, and restoring Free within USD 1, with the
restart/ephemeral-upload risk disclosed. That authorization persists: **do not
ask again for the same temporary plan change or cost ceiling**. It does not
authorize a new persistent paid service or repeating the production reset.

On the exact preview service, CLI `services update --plan starter` returned
HTTP 500 `internal server error`. A read confirmed the original Free plan and
unchanged service timestamp. Trying the documented equivalent `0.5c-512mb`
returned the same error and left the service unchanged. A minimal documented
REST request, `PATCH /v1/services/srv-daipkbuk1f9s73952trg` with
`{"serviceDetails":{"plan":"starter"}}`, also returned HTTP 500. The final
independent service read still reported `free` and last modification
`2026-09-20T08:49:49.051881Z`. Thus this is no longer waiting for authorization;
the requested provider mutation has failed. No deployment was triggered, no
paid instance was confirmed, and no preview database command ran.

Browser discovery still sees Chrome, but refreshing its tabs timed out after
20 seconds before reaching Render. No browser action was performed. Do not
present this as a successful dashboard attempt or a database inventory.

Resume from the existing administrative credentials and the approved scope when
Render's update operation is available: read current service/deployment/job
state first, avoid duplicate provisioning, apply the temporary plan change once,
deploy the same reviewed preview commit `10eac842fd06ac0be54fd5a70caae3f78f8a8e06`
only if required, then run the reviewed inventory before preparing its bounded
backup and reset. Restore and independently verify Free before reporting done.
Reconfirm account-set bounds from the actual inventory rather than reusing
production counts. The repeated 500 responses are a current provider blocker,
not evidence of a global Render outage or a missing payment method.

### Approved one-off attempt and confirmed platform limit — 2026-09-20

The owner approved **up to USD 1 for a bounded temporary Render job, without a
new subscription**. The reviewed read-only inventory was submitted to the exact
preview service with explicit paid job plan `plan-srv-006`. Render rejected the
request with HTTP 400: `free tier plans are not supported for jobs`. A subsequent
job listing was still empty. No database inventory or reset ran. This is a limit
on the **base service**, not missing login or a missing job-plan argument: CLI
v2.28.0's input-to-request path passes `PlanId`, and Render's
[free service documentation](https://render.com/docs/free) explicitly excludes
one-off jobs and shell access on Free instances.

An attempted alternative to create a paid background worker and supply the
preview connection as a secret file was **rejected by automatic approval review
before execution**. The review identified creation of a persistent paid service
and uploading its database connection secret as beyond the authorized bounded
one-off job. No alternate API or indirect execution was used to evade this
decision. A fresh service listing confirmed no temporary worker was created.

The existing paid Dawaee worker was checked as a possible administration route
with only an SSH `true` command. CLI authentication and instance selection worked,
but SSH failed resolving `ssh.frankfurt.render.com`; no remote command or database
query ran. The connection was closed. No SSH key was added and no network rules
were changed. Production services were not modified.

The concrete remaining option is a separately authorized **temporary compute-plan
change on the existing preview service** `srv-daipkbuk1f9s73952trg` from `free` to
`starter` (equivalent `0.5c-512mb`), followed by the bounded inventory, encrypted
snapshot, rollback rehearsal, reset and independent verification. Restore `free`
and verify it afterward; keep the aggregate cost within the approved USD 1.
This option is **prepared only, not applied**. It needs express authorization
because it changes the service plan rather than just launching the approved job.
It requires deployment/restart of the same reviewed preview artifact; ephemeral
preview uploads can be lost on restart. See
[compute-plan changes](https://render.com/docs/compute-plans). Do not update
production, create a new paid service, copy owner credentials to another service,
or leave paid preview compute running without that scope being approved.

Current draft head `0ba50d705967a314d38791d48c0e1a73a8ce8314` completed
[CI](https://github.com/NAIFMUSFER/dawaee/actions/runs/35502760857) and
[Security scan](https://github.com/NAIFMUSFER/dawaee/actions/runs/35502760851)
successfully. These source checks do not establish preview cleanup, email receipt
or visual acceptance. No preview account has been deleted, and no new email or
application deployment was initiated in this attempt.

### Administrative access update — 2026-09-20

The owner completed Render's official CLI device authorization. CLI v2.28.0 was
downloaded from its official release and verified against the published SHA-256.
Authenticated workspace listing, selecting the existing workspace, and fetching
the exact preview database's connection details succeeded. Credentials remain
local and were not logged or committed. **Lack of Render administrative
authentication is no longer the blocker.**

A certificate-verified PostgreSQL connection from this execution environment
failed at hostname resolution (`EAI_AGAIN`). A connection through the configured
outbound proxy timed out. The execution tool rejected the request for expanded
network permissions because sandbox escalation is disabled. No external-access
rules or TLS verification were changed. The database reports an empty external
IP allowlist, so credentials alone would not establish external connectivity.

An internal one-off job was initially proposed; the later attempt above confirmed
that it requires a paid base service and cannot run on the current Free preview.
[Render bills such jobs per second](https://render.com/docs/one-off-jobs); the
preview's free service has no SSH or dashboard shell. No job was launched and
the service's job list was empty. Because the owner previously prohibited new
paid providers, chargeable compute is left for explicit authorization rather
than assuming the device-login approval also approves additional charges.

The concrete first job is prepared in
`scripts/ops/preview-account-inventory-20260920.cjs`: a 30-second, read-only
repeatable-read transaction against the exact internal preview host/database
and ordinary owner role. It logs only aggregate counts and an account-set
fingerprint. It rejects unexpected database targets and preserves the existing
internal TLS selection. Syntax and two pre-connection refusal checks passed;
the script has **not** run against Render or established a database connection.
It is standalone operator code, not a migration or startup hook. Running it as
a one-off job can use an inline copy from the reviewed file and does not require
an application deployment. A backup/rehearsal/commit is still required after
reviewing the inventory; this script does not delete accounts.

Current dependency: authorize the temporary chargeable internal execution route,
or provide an execution environment with permitted PostgreSQL connectivity.
Do not ask for another Render login or for credentials in chat. The following
paragraphs describe the earlier state before device authorization.

The affected registration page is hosted by Render service
`srv-daipkbuk1f9s73952trg`, database `dpg-daipq80jo6nc73fsmhhg-a`
(`dawaee_audit_db`). No preview account was modified in this run. Earlier
attempts through the provided read-only SQL connector failed with EOF/TLS;
browser navigation failed during CDP refresh before reaching the database page.
The latest additional read-only check was interrupted and is not a new success
or failure claim. No configured Render CLI login/API key or owner connection was
available locally. The connector's read-only contract would not permit cleanup
even if its connection recovered.

The remaining dependency is a working, authorized **administrative write
connection to this preview database**, or an operational authenticated Render
browser session that can provide its normal operator access. Reconnecting a
read-only SQL connector alone does not grant write capability. No public network
allowlist change, TLS downgrade, startup reset, credential export endpoint or
provider creation was used to work around that limit.

Once access is available, inventory and snapshot all preview accounts within the
newly authorized scope, rehearse and execute a bounded one-time cleanup, invalidate
registration/email/phone/recovery proofs as applicable to schema 0095, and verify
zero usable old identities/sessions. Do not execute the production-specific
script against preview, or replay the already recorded production batch.

## Earlier source, checks and deployment (before preview execution)

The previous application source `860b1105e995d1c3a20a63cd30c0a3b6c0341a39`
completed [CI #1153](https://github.com/NAIFMUSFER/dawaee/actions/runs/35500463148)
successfully. That result does not certify the new operator SQL, preview cleanup,
rendered user interfaces or email receipt. The SQL evidence above comes from its
actual rollback rehearsal and independently verified production commit.

Only the operator script and audit evidence are added to the draft PR in this
follow-up. No application deployment, new binary, PR merge, new test registration
or email was initiated. Missing registration mail on preview is **not resolved**
by the production cleanup.
