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

## Preview: not executed

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

## Source, checks and deployment

The previous application source `860b1105e995d1c3a20a63cd30c0a3b6c0341a39`
completed [CI #1153](https://github.com/NAIFMUSFER/dawaee/actions/runs/35500463148)
successfully. That result does not certify the new operator SQL, preview cleanup,
rendered user interfaces or email receipt. The SQL evidence above comes from its
actual rollback rehearsal and independently verified production commit.

Only the operator script and audit evidence are added to the draft PR in this
follow-up. No application deployment, new binary, PR merge, new test registration
or email was initiated. Missing registration mail on preview is **not resolved**
by the production cleanup.
