# Production release runbook

Written during P17 (read-only audit, 2026-09-06). **Nothing in this document has
been executed.** It is the procedure for a release that has not happened yet.

No secret values appear here. Where a value is needed, the runbook names the
variable and where to read it, never the value.

---

## The situation this runbook exists for

| | |
|---|---|
| Repository `main` | see `git rev-parse HEAD` — P18-R added `0030` and a startup gate |
| `dawaee-api` live commit | `db7061f1ae8fc52a02d68aea76da8a46ff382b04` |
| `dawaee-worker` live commit | `db7061f1ae8fc52a02d68aea76da8a46ff382b04` |
| Delta | 113 files changed, 20 152 insertions, 380 deletions |
| Pending migrations | **11** — `0020` … `0030` (production ledger stops at `0019`) |

Production is running the **audit baseline**. Every fix from P5 through P16 is
unshipped. This is therefore not a routine deploy: it is a ten-migration,
twenty-thousand-line jump, and it should be treated as the highest-risk release
the project has had.

### The sequencing problem, stated plainly

`render.yaml` puts `preDeployCommand: ./scripts/migrate.sh` on the **worker**
only. The API has no pre-deploy command, because Render does not offer one on
the free plan. Both services carry `autoDeployTrigger: commit`, so a push to
`main` starts **both** deploys at the same time.

That means the API can be serving new code before the worker's pre-deploy has
finished applying migrations. In this particular release that is not a
theoretical concern:

| New API code path | Requires | From migration |
|---|---|---|
| Startup itself | the whole ledger through `0030` | **the API now refuses to boot below it** |
| Shared auth rate limiting | `app.consume_rate_budget` | `0029` |
| Password change | `app.password_hash_for_user` | `0022` |
| OTP challenge issue | one-live-challenge unique index | `0028` |
| Worker's session reads | `auth_sessions` grant to `dawaee_worker` | `0021` |

An API that boots before `0029` lands used to fail every authentication request
with an undefined-function error while `/health` and `/health/ready` both
answered 200 — measured, twelve logins out of twelve. **It no longer boots at
all**: `assertSchemaContract` compares the shipped `db/migrations` against the
ledger and exits 1 before binding a port, naming the migrations that are
missing. The ordering below is still the right ordering; it is now enforced by
the artefact rather than by the runbook.

**The runbook below therefore does not rely on auto-deploy.** Auto-deploy is
suspended for the release, migrations are driven deliberately, and the API is
started last. Step 0 is what makes the rest of it true.

---

## Preconditions for the whole release

Do not begin until every line is true.

- [ ] CI is green on `1cafd5a` for **both** PostgreSQL 16 and 17 (P16 classified
      actual GitHub Actions execution as NOT RUN — this must become an observed
      green run, not an assumption).
- [ ] A named operator is at a machine with the Render dashboard, the Supabase
      dashboard, and `psql`.
- [ ] A second person is available to authorize a rollback.
- [ ] The release is scheduled for a window with the fewest scheduled doses.
      Reminders stop while the worker is down; a dose window missed during a
      deploy is a patient-visible failure, not just an ops one.
- [ ] A Supabase point-in-time / manual backup taken **within the last hour**,
      and its identifier written down (Step 2).
- [ ] `PUSH_PROVIDER` decision made — see the Known-state section below.

---

## Step 0 — Stop auto-deploy from racing the release

**PRECONDITION:** Nothing. Do this first, before anything is merged.

**ACTION:** In the Render dashboard, set auto-deploy to **off** on all six
Dawaee services:

- `dawaee-api` (`srv-dad9mvf10e5c73dva9vg`)
- `dawaee-worker` (`srv-dad9meijnfac73f1o3tg`)
- `dawaee-api-phop`, `dawaee-api-htra`, `dawaee-worker-phop`, `dawaee-worker-htra`

The four legacy services are included because they also carry
`autoDeploy: yes` on `main` and will burn build minutes and produce four red
badges during the release, which is exactly when a red badge needs to mean
something. See `docs/RENDER-CLEANUP-RUNBOOK.md`.

**EXPECTED RESULT:** All six services show auto-deploy disabled. A push to
`main` now builds nothing.

**ROLLBACK CONDITION:** None — this step is reversible and removes risk.

**NOTE:** `render.yaml` still says `autoDeployTrigger: commit`. A Blueprint sync
re-asserts that. If the dashboard setting reverts mid-release, a Blueprint sync
fired; stop and re-disable before continuing.

---

## Step 1 — Merge to `main` behind required checks

**PRECONDITION:** Step 0 complete. CI green on the branch head.

**ACTION:** Merge the release branch into `main` through a pull request. Do not
push directly.

**EXPECTED RESULT:** `main` is at the release commit. Record it:

```bash
git rev-parse HEAD    # write this down; it is referenced throughout
```

Because of Step 0, no deploy starts.

**ROLLBACK CONDITION:** CI fails on `main` after merge → revert the merge
commit and stop. Nothing has reached production; there is nothing to undo
beyond the revert.

**BLOCKER:** P16 classified branch protection and required checks as NOT
VERIFIED. If `main` has no required status checks, this step is a convention
rather than a control. Verify before relying on it.

---

## Step 2 — Back up the database, and prove the backup exists

**PRECONDITION:** Steps 0–1 complete.

**ACTION:** In Supabase, take a manual backup of the production project. Record
its identifier and timestamp.

Then capture the pre-release schema state so a divergence is provable later:

```bash
psql "$DATABASE_URL" -tAc \
  'SELECT filename, applied_at FROM schema_migrations ORDER BY filename' \
  > pre-release-ledger.txt
```

**EXPECTED RESULT:** `pre-release-ledger.txt` ends at `0019_client_event_scope.sql`.
A backup identifier is written down.

**ROLLBACK CONDITION:** Backup cannot be taken or verified → **stop the
release.** Ten migrations including a `DELETE` (`0025`) and an `UPDATE` (`0028`)
must not be applied without a restore point.

**NOTE:** `dawaee-db` (`dpg-dacego15efls73e58ukg-a`) is a *separate*, free-plan
PostgreSQL 16 instance that shows ~0 connections and expires **2026-10-03**. It
is believed not to be the production database, but that inference has not been
confirmed by reading `DATABASE_URL`. Confirm which host `DATABASE_URL` names
**before** backing up, so the backup is of the right database.

---

## Step 2b — Preflight, which now refuses before it can half-apply

**PRECONDITION:** Step 2 complete.

**ACTION:**

```bash
DATABASE_URL='…' DAWAEE_APP_PASSWORD='…' DAWAEE_WORKER_PASSWORD='…' \
  ./scripts/migrate.sh --preflight-only
```

**EXPECTED RESULT:** five lines, exit 0, and **nothing applied**:

```
preflight: connection
preflight: migrating as '<role>'
preflight: role administration OK
preflight: definer policies
preflight complete — no migration was applied
```

**ROLLBACK CONDITION:** any non-zero exit → stop and fix what it names. Nothing
has been applied, which is the entire point: P18 measured both of the failures
this replaces, and both of them committed migrations first.

**WHAT IT CATCHES.** See `docs/RUNBOOK-migrate-preflight.md`. In short: migrating
as a runtime role; a migration role that cannot set the runtime roles' passwords
(PostgreSQL 16+ needs ADMIN on a role to do that, and the old script discovered
this *after* committing ten migrations); and a missing definer privilege path,
without which `0025`'s dedup `DELETE` matches zero rows in silence and the index
build that follows aborts the deploy at `0025` with `0020`–`0024` already
committed.

**A SIDE EFFECT WORTH KNOWING.** The preflight installs the definer policies on
whatever schema it finds — including a database still at `0019`. Measured: the
currently deployed build (`db7061f`) returns **404** to `POST /v1/auth/register`
on a database whose owner cannot bypass row-level security, and **200** on the
same database seconds after the preflight runs. If production is in that state,
the preflight alone repairs registration before a single migration is applied.

---

## Step 3 — Rehearse the migrations against a copy

**PRECONDITION:** Step 2b clean.

**ACTION:** Restore the backup into a scratch database **owned by a role with
`rolsuper = false` and `rolbypassrls = false`** — this is not optional, and is
the single thing P18's rehearsal got wrong — then:

```bash
DATABASE_URL="postgres://…/scratch" ./scripts/migrate.sh
DATABASE_URL="postgres://…/scratch" ./scripts/migrate.sh   # second run
psql "postgres://…/scratch" -f db/seed/rls_probe.sql
```

**EXPECTED RESULT:**

- First run prints `applying 0020_…` through `applying 0030_…`, then
  `applied 11 migration(s)`.
- Second run prints exactly `no pending migrations`.
- The RLS probe prints no line beginning `FAIL`.
- Record the wall-clock duration. Measured on a seeded database: **0.9 s**.

**ROLLBACK CONDITION:** any migration fails, the second run is not a no-op, or
the probe reports FAIL → **stop.** Nothing has touched production.

**IF THE SCRATCH DATABASE IS OWNED BY A SUPERUSER**, this step proves nothing.
That is precisely how P18's first rehearsal passed while the upgrade would have
aborted at `0025` in production.

## Step 4 — Apply migrations, deliberately, before any new code runs

**PRECONDITION:** Step 3 clean. Backup identifier in hand. Outage window open.

**ACTION:** Run the migration from an operator machine that can reach the
production database, at the release commit, with the production `DATABASE_URL`,
`DAWAEE_APP_PASSWORD` and `DAWAEE_WORKER_PASSWORD` supplied from the environment
— never typed into a file, never echoed:

```bash
git checkout <release commit>
./scripts/migrate.sh 2>&1 | tee migrate-$(date +%s).log
```

Migrations `0020`–`0029` are additive: no `DROP TABLE`, no `DROP COLUMN`, no
`TRUNCATE`. Two carry data statements and must be read before running:

| Migration | Data statement | Effect |
|---|---|---|
| `0025_missed_event_uniqueness.sql` | `DELETE` | removes duplicate missed-dose events so a unique index can be created |
| `0028_one_live_otp_challenge.sql` | `UPDATE` | retires surplus live OTP challenges so one-live-challenge can be enforced |

Neither destroys medication, dose or profile data. Both are irreversible without
the Step 2 backup.

**EXPECTED RESULT:** `applied 10 migration(s)`, then `applying role grants…`,
then `migrations complete`. The old code (`db7061f1`) is still serving and is
unaffected: every migration is additive, so the running API keeps working.

**ROLLBACK CONDITION:** Any migration fails → the transaction for that file
rolls back and the ledger has no row for it. Do **not** retry blindly. Read the
log, and if the schema is in a state the rehearsal did not produce, restore from
the Step 2 backup. Production is still on old code, so a restore costs data
written since the backup, not a broken service.

**IF `migrate.sh` REFUSES** with `was already applied but its contents have
changed` — a shipped migration was edited. Stop. That is a repository defect,
not a deploy problem.

---

## Step 5 — Deploy the worker

**PRECONDITION:** Step 4 succeeded. Migrations at `0029`.

**ACTION:** In Render, deploy `dawaee-worker` at the release commit
(Manual Deploy → the recorded commit).

Its `preDeployCommand: ./scripts/migrate.sh` will run again. After Step 4 this
is a no-op and that is the point: it is the confirmation that the worker sees
the same ledger the operator did.

**EXPECTED RESULT:**

- Pre-deploy log contains `no pending migrations` and `migrations complete`.
- The service reaches `live`.
- Within 60 seconds the worker logs a tick.
- **`permission denied for table auth_sessions` stops appearing.** It has been
  logged every hour continuously on `db7061f1`; `0021_worker_least_privilege.sql`
  is the fix. Its disappearance is the observable proof that `0021` landed.

**ROLLBACK CONDITION:** Pre-deploy exits non-zero, the worker crash-loops, or
the `auth_sessions` error persists → roll the worker back to `db7061f1` (Step
R1). The API has not moved, so the system is back to its pre-release state with
the new schema in place — which is safe, because the migrations are additive.

**WATCH FOR:** `providers: {"push":"mock"}`. If `PUSH_PROVIDER` is still unset,
the worker records deliveries instead of sending them and **no patient receives
a reminder.** See Known state.

---

## Step 6 — Deploy the API

**PRECONDITION:** Step 5 green for at least 5 minutes with a clean tick log.

**ACTION:** In Render, deploy `dawaee-api` at the same commit.

**EXPECTED RESULT:** Build succeeds; the service passes its
`healthCheckPath: /health` and goes `live`.

**ROLLBACK CONDITION:** The service fails its health check, crash-loops, or logs
`fatal startup error: Invalid environment configuration` → roll back to
`db7061f1` (Step R2). A config error here means a variable the new code requires
was never set; the old image does not require it.

**NOTE ON BUILD IDENTITY:** `/version` reads `RENDER_GIT_COMMIT` — which Render
sets itself, from the commit it built — before falling back to the `GIT_COMMIT`
build argument. So a Render deploy now reports its real SHA with no build
argument at all. `unknown` here means the platform variable was absent and
should be investigated; a *specific but wrong* SHA remains a serious finding.

---

## Step 7 — Health and readiness

**PRECONDITION:** Step 6 live.

**ACTION:**

```bash
curl -fsS https://<api-host>/health
curl -fsS https://<api-host>/health/ready
curl -fsS https://<api-host>/version
```

**EXPECTED RESULT:**

- `/health` → `{"status":"ok","service":"dawaee-api","time":"…"}`
- `/health/ready` → **200** with `status: "ready"` and `checks.database.ok: true`,
  meaning the database is reachable **as the application role** — this is the
  check that proves `dawaee_app`'s password in Postgres matches the one Render
  handed the API. Step 4 rewrote both role passwords; if they disagree, this is
  where it shows. A failed database check returns **503** and `status:
  "degraded"`.
- Read `mockedIntegrations` in that same response. It names every provider still
  on a stub. On current production it will contain `push`. This endpoint is the
  authoritative answer to "are reminders actually being sent" — do not infer it
  from anywhere else.
- `/version` → exactly `{service, commit, version, builtAt, schema}` and nothing
  else. `commit` now comes from Render's own `RENDER_GIT_COMMIT` first, so it
  reports the real SHA without anyone maintaining a build argument; `schema` is
  the migration this build requires.

**ROLLBACK CONDITION:** `/health/ready` fails while `/health` succeeds → the
process is up but cannot reach the database as `dawaee_app`. Roll back the API
(R2) and re-run the role-grant half of `migrate.sh`.

**BLOCKED IN THIS AUDIT:** egress to `*.onrender.com` is blocked by proxy policy
from the environment P17 ran in, so no probe was executed. These commands are
written, not verified.

---

## Step 8 — TLS verification

**PRECONDITION:** Step 7 passing.

**ACTION:**

```bash
openssl s_client -connect <api-host>:443 -servername <api-host> </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

And confirm the **database** side, which matters more: `DATABASE_SSL` must be
`true` on both services. The value is a literal in `render.yaml`, so a Blueprint
sync re-asserts it — but confirm it was not overridden in the dashboard.

**EXPECTED RESULT:** A valid, unexpired certificate chaining to a public root
for the API host. `DATABASE_SSL=true` on both services.

**ROLLBACK CONDITION:** `DATABASE_SSL` is anything other than `true` — in
particular `no-verify` — → treat as a security incident, not a deploy issue.
Correct it and redeploy. The service is designed to refuse to boot in production
with a weaker value; if it booted anyway, that guard has regressed.

---

## Step 9 — Smoke tests

**PRECONDITION:** Steps 7–8 passing.

Run against production with a **dedicated test account**, never a real patient
account. Every step below is a normal user action; none of it writes to another
tenant.

| # | Action | Expected | Proves |
|---|---|---|---|
| 1 | Request an OTP for the test number | 200; exactly one live challenge | `0028` |
| 2 | Request a second OTP immediately | rate-limited, not a second live challenge | `0029` + `0028` |
| 3 | Complete login | session issued | auth plane |
| 4 | `POST /v1/profiles` | **201 with the profile body** | the P12 fix for a 404 that broke profile creation for every user |
| 5 | Create a medication and a schedule | 201 | core write path |
| 6 | Read the schedule as the owner | the dose appears | read path |
| 7 | Read the same profile as a second, unrelated account | **403 or 404 — never data** | cross-tenant isolation |
| 8 | Invite a caregiver with `view_schedule` but not `view_medications` | explicit **403** on medication-bearing routes, not an empty list | the P12 authorization decision |
| 9 | Confirm a dose | recorded once | dose write path |
| 10 | Wait one worker tick and read `job_runs` | a row, with **no raw error text** | P13 operational-error sanitization |

**EXPECTED RESULT:** All ten as described. Test 4 and test 7 are the two that
must never be waved through.

**ROLLBACK CONDITION:** Test 7 returns another tenant's data → **immediate full
rollback (R1 + R2) and treat as a data-exposure incident.** Any other failure →
assess; a failure in 4, 8 or 10 means the release did not deliver what it
claims and should be rolled back.

**AFTERWARDS:** delete the test data. Do not leave synthetic patients in
production.

---

## Step 10 — Native build

**PRECONDITION:** API release verified through Step 9 and stable for at least 24
hours. The mobile app must never ship ahead of the API it calls.

**ACTION:**

```bash
cd apps/mobile
npm ci --legacy-peer-deps     # NOT a workspace member; this flag is required
npx tsc --noEmit
npx expo-doctor
eas build --platform ios --profile production
eas build --platform android --profile production
```

**EXPECTED RESULT:** Typecheck clean, both builds succeed, build IDs recorded
alongside the API release commit.

**ROLLBACK CONDITION:** Build failure → fix before release. Nothing to roll
back; the API release stands on its own.

**NOT RUN:** `expo-doctor`'s online compatibility checks were classified NOT RUN
in P16 (no network in the audit environment). This is the step where they
actually run.

---

## Step 11 — Device tests

**PRECONDITION:** Step 10 produced installable builds.

Real hardware. Not a simulator. The claims below cannot be verified any other
way, and several concern platform behaviour the project is explicitly forbidden
to overstate.

| Test | Device | Must observe |
|---|---|---|
| Notification permission prompt | iOS + Android | Granted and denied both handled |
| Reminder arrives with the app closed | iOS + Android | The notification actually appears |
| Notification content | both | **No medication name or dose in the visible payload** — the P13 notification-privacy finding |
| Reminder while offline | both | No crash; state reconciles on reconnect |
| Token storage | both | Auth tokens in the secure store, **never AsyncStorage** |
| Arabic RTL layout | both | Correct on the reminder and dose screens |
| Timezone change | both | Schedule follows the configured travel policy |
| Emergency QR | both | Scans to the limited card, **never full account information** |

**EXPECTED RESULT:** Every row observed and recorded with device model and OS
version.

**ROLLBACK CONDITION:** Notification privacy or token storage fails → do not
ship the mobile release. The API release is unaffected and stays.

**STANDING CONSTRAINT:** if a background-delivery behaviour cannot be observed
on the device, it is NOT RUN. It does not become PASS because the code looks
correct.

---

## Step 12 — Mobile release

**PRECONDITION:** Step 11 fully green on both platforms.

**ACTION:** Submit to App Store Connect and Google Play. **Staged rollout on
Android — start at 10%.** iOS phased release enabled.

**EXPECTED RESULT:** Builds accepted; rollout begins.

**ROLLBACK CONDITION:** Crash rate above baseline, or any report of a reminder
not arriving → halt the rollout immediately (Play halts; iOS pauses the phased
release). A mobile rollback is a *new build*, not a revert, so halting early is
the only fast control that exists.

---

## Step 13 — Re-enable auto-deploy

**PRECONDITION:** The release is stable and accepted.

**ACTION:** Re-enable auto-deploy on `dawaee-api` and `dawaee-worker` **only**.
Leave it off on the four legacy services.

**EXPECTED RESULT:** Two services on auto-deploy; four silent.

**NOTE:** re-enabling restores the API/worker deploy race described at the top
of this document. It is tolerable for ordinary releases where no migration is
pending, and it is not tolerable for any release that adds one. The durable fix
— a paid API instance with its own `preDeployCommand`, or a deploy gate that
orders the two — is a release blocker for the *next* migration-bearing release,
not this one.

---

# Rollback plan

Rollback is by **deploy**, never by editing production. Two independent
rollbacks, in this order.

### R1 — Roll the worker back

Render → `dawaee-worker` → Deploys → the last deploy on `db7061f1` → **Rollback**.

Its pre-deploy runs `migrate.sh` at the *old* commit. That commit's
`db/migrations/` contains only `0001`–`0019`, and the loop applies pending files
— it never removes applied ones. Against a database at `0029` it prints
`no pending migrations` and exits 0. **The schema stays at `0029`.**

*Time: one deploy cycle. Data loss: none.*

### R2 — Roll the API back

Render → `dawaee-api` → Deploys → the last deploy on `db7061f1` → **Rollback**.

Confirm `/health` returns 200 afterwards.

*Time: one deploy cycle. Data loss: none.*

### R3 — Schema rollback (only if R1+R2 is insufficient)

**There are no down-migrations.** This is deliberate: a down-migration that
drops a column drops the data in it, and this system stores medication
schedules.

Schema rollback therefore means **restore the Step 2 backup**, which loses every
row written since the backup was taken.

Require, before doing it:

- The specific failure that code rollback did not fix, written down.
- Explicit operator authorization from a second person.
- Acknowledgement of the exact data window that will be lost.

**Do not perform R3 to tidy up.** Migrations `0020`–`0029` are additive; old code
runs against the new schema without error. Leaving the schema ahead of the code
is the correct resting state after a rollback.

### Rollback decision table

| Symptom | Action |
|---|---|
| Migration failed mid-run | Stop. Old code still serving. Read the log; restore only if the schema is in an unrehearsed state |
| Worker crash-loops | R1 |
| Worker pre-deploy fails | R1 |
| `auth_sessions` errors persist after deploy | R1; `0021` did not land |
| API fails health check | R2 |
| API config error at boot | R2; a required variable is unset |
| `/health/ready` fails, `/health` passes | R2, then re-run role grants |
| Auth broken for everyone | R2 first; if it persists, R1 |
| **Cross-tenant data visible** | R1 + R2 immediately; incident process |
| Reminders not delivered | Check `PUSH_PROVIDER` before rolling back — mock is a config state, not a regression |
| Mobile crash spike | Halt the store rollout; API stays |

### What rollback does **not** undo

- `0025`'s `DELETE` of duplicate missed-dose events.
- `0028`'s `UPDATE` retiring surplus live OTP challenges.
- Role passwords rewritten by `migrate.sh`.
- Any row written by the new code while it was live.

Only R3 reaches these, and only by losing the window.

---

# Known state at the time of writing

These are measured facts about production on `db7061f1`, not predictions. Each
one affects the release.

| Observation | Consequence for this release |
|---|---|
| `providers: {"push":"mock"}` in `env: production` | **Push is mocked in production.** Reminders are recorded, not sent. Deploying new code changes nothing about this. Setting `PUSH_PROVIDER` and `EXPO_ACCESS_TOKEN` is a separate, deliberate decision that turns on real delivery to real patients — do it in its own change, with its own verification, not folded into this release |
| `permission denied for table auth_sessions`, hourly, continuously | Fixed by `0021`. Its disappearance is Step 5's success signal |
| `/health` polled every 5 s from `10.216.24.39`; **no external traffic at all** | Production has no real users yet. That lowers the risk of this release considerably — and it means proxy/TLS topology (P17 §19) stays NOT RUN because there is nothing to observe |
| Four legacy services never boot; no environment variables at all | Not an attack surface. Still six builds per push and four red badges. Step 0 handles them for the release; `docs/RENDER-CLEANUP-RUNBOOK.md` handles them permanently |
| `dawaee-db` free plan, `expiresAt: 2026-10-03`, ~0 connections | Believed unused, **not confirmed**. Confirm which host `DATABASE_URL` names before Step 2, or the backup may be of the wrong database |
| `/version` will report `commit: "unknown"` on Render | Expected: build args are not passed. Traceability comes from the deploy record |

---

# What this runbook cannot promise

Stated so no one reads a green run as more than it is:

- **GitHub Actions has never executed this CI configuration.** P16 classified it
  NOT RUN. Step 1's precondition is the first real execution.
- **Branch protection and required checks are NOT VERIFIED.** Step 1's control
  is only as strong as a setting nobody has read.
- **No endpoint of the deployed service has been probed.** Egress to
  `*.onrender.com` is blocked from the audit environment; Steps 7–9 are written,
  not verified.
- **No real-device mobile test has been run.** Step 11 is entirely NOT RUN.
- **Base image is not pinned by digest.** `node:22-bookworm-slim` is mutable, so
  two builds of the same commit can differ. Open decision, documented in the
  `Dockerfile`.
- **GitHub Actions are not SHA-pinned.** BLOCKED — resolving tags to SHAs
  requires registry access the audit environment does not have.
- **Retention policy has no legal approval.** POLICY MISSING since P13. The
  technical enforcement exists; the approval does not. Saudi PDPL applicability
  has not been formally assessed, and nothing here should be read as a
  compliance claim.
