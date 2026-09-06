# P18-R — release candidate remediation

Executed 2026-09-06. **Nothing was pushed, deployed, migrated against production,
or changed on Render.** No production environment variable was written, no
service or database was deleted, no provider credential was enabled.

---

## Root cause

A `SECURITY DEFINER` function runs as the role that owns it. Here that is the
role that runs migrations, which also owns every table. Under
`FORCE ROW LEVEL SECURITY` **the owner is not exempt from its own tables'
policies** unless it is a superuser or holds `BYPASSRLS`, and no managed
PostgreSQL grants either.

Migration `0008` diagnosed this exactly, and fixed it — for seven tables, named
in a hand-written array:

```sql
FOREACH t IN ARRAY ARRAY[
  'users', 'patient_profiles', 'caregiver_relationships',
  'auth_sessions', 'auth_otp_challenges', 'medications', 'emergency_cards']
```

Twenty-six tables now carry `FORCE ROW LEVEL SECURITY`. Six of the seven named
force it; the other twenty were created after `0008` and were never added.

**The root cause is not the missing policies. It is that the list was a list.**
A property enforced by an array that a human must remember to extend is a
property that decays on a schedule, and nothing in 1013 tests could see the
decay because `scripts/db-reset.sh` created the test database as `postgres` — a
superuser, exempt for free. The suite proved its properties against a
configuration production does not have.

Two consequences, both measured on databases differing only in the owner's
`rolsuper` and `rolbypassrls`:

**1. Registration.** `app.register_with_password` cannot `INSERT user_credentials`.

```
ERROR:  new row violates row-level security policy for table "user_credentials"
CONTEXT: PL/pgSQL function register_with_password(...) line 24
```

`POST /v1/auth/register` → **404**. The product is unusable from its first
request. Demonstrated on the *currently deployed* build (`db7061f`), at schema
`0019`, on the same database seconds apart:

| | `POST /v1/auth/register` |
|---|---|
| before the definer sweep | **404** |
| after the definer sweep (19 of 25 forced tables covered) | **200** |

**2. A worse one, which P18 missed because its rehearsal owner had `BYPASSRLS`.**
Migration `0025` deletes duplicate `missed` events before creating a unique
index. Under FORCE RLS with no owner policy, that `DELETE` matched **zero rows —
silently**, because RLS filtering a `DELETE` to nothing is not an error. The
index build then failed:

```
  applying 0025_missed_event_uniqueness.sql
ERROR:  could not create unique index "dose_events_one_missed_idx"
DETAIL:  Duplicate keys exist.
```

Exit non-zero with `0020`–`0024` **already committed**, ledger at 24. In
production that runs inside the worker's `preDeployCommand`: a failed deploy and
a schema no commit corresponds to.

---

## 0030 design

### What was rejected, and why

| Rejected | Reason |
|---|---|
| Patch `user_credentials` only | Treats the symptom. Nineteen other tables have the same hole and the next one ships with the next migration. |
| A policy `TO PUBLIC USING (true)` | Permissive policies union. A PUBLIC policy would apply to `dawaee_app` and `dawaee_worker` too and silently dissolve the tenancy model. |
| Relax `FORCE ROW LEVEL SECURITY` | Exempts the owner by removing the control rather than by naming who is exempt, and removes it for every future reader of the schema. |
| Extend `0008`'s array | `0008` has shipped and is immutable. A longer list is the same defect with a later expiry date. |
| Put the whole fix in `0030` | `0025` sorts before `0030`. Nothing numbered 0030 can rescue it. |

### What was built

**`db/maintenance/definer_policies.sql`** — defines `app.ensure_definer_policies()`
and calls it. The function enumerates `pg_class` for every
`FORCE ROW LEVEL SECURITY` table in `public` and creates a missing
`<table>_definer` policy `TO current_user`. Not `SECURITY DEFINER` — it runs as
its caller, which must be the owner. Idempotent; reports only when it creates
something.

It runs as a **deploy preflight**, before any pending migration, and again after
the run. That placement is forced: `0025` needs the policy on `dose_events` to
exist already, and so do the backfills in `0016` and `0017` for any database
restored from a dump older than they are.

**`db/migrations/0030_definer_privilege_model.sql`** — where the invariant stops
being a convenience of the deploy script and becomes a condition of the schema.
It adds no table and no column. It asserts, and aborts the migration otherwise:

1. `app.ensure_definer_policies()` exists (a deploy that skipped the preflight
   may already have committed a silently-empty DML statement — stop loudly).
2. Every FORCE-RLS table has a definer policy.
3. No definer policy names `PUBLIC`, `dawaee_app`, `dawaee_worker`, or more than
   one role; **no policy anywhere in `public` is granted to `PUBLIC`**; neither
   runtime role can become the owner by membership or `SET ROLE`; the owner does
   not inherit either runtime role; neither runtime role holds `SUPERUSER` or
   `BYPASSRLS`.
4. No table enables row-level security without forcing it.
5. The read-side definer predicates actually execute rather than raising
   `insufficient_privilege` — behaviour, not just catalogue.

Assertion 3 fired on its first run and found a real regression: `0021` had
rewritten `caregiver_rel_update` and dropped its `TO dawaee_app` clause, which in
PostgreSQL means `TO PUBLIC`. Nothing was actually widened — the predicate
evaluates false for the worker, which has no `app.user_id` — but "happens to be
false" is not a control. `0021` is unshipped (production stops at `0019`) and was
corrected in place.

### Why `USING (true)` is not a weakening

The grantee is the role that already owns the tables. It can
`ALTER TABLE … DISABLE ROW LEVEL SECURITY` whenever it likes; no policy can
constrain it, and pretending otherwise would be theatre. The security argument is
entirely about **reach**, and every clause of it is asserted:

- the policy names exactly one role — never PUBLIC, never a runtime role;
- `dawaee_app` and `dawaee_worker` are not that role, are not members of it, and
  cannot `SET ROLE` to it (proved by catalogue *and* by an actual refused
  `SET ROLE` from a live connection);
- every policy constraining the runtime roles is untouched, and FORCE RLS stays
  on for all twenty-six tables;
- with no `app.user_id` set, `dawaee_app` still reads **zero** rows from
  `patient_profiles`, `medications`, `dose_occurrences` and `user_preferences`,
  and is still refused outright on `user_credentials`.

The reverse direction is deliberately permitted and is required: PostgreSQL 16
needs the migration role to hold `ADMIN` on the runtime roles to set their
passwords. It is granted `WITH ADMIN TRUE, INHERIT FALSE, SET FALSE` —
administration without inheritance. That detail was measured, not assumed: with
plain `WITH ADMIN OPTION`, the owner inherited `dawaee_worker`'s policies, read
`dose_events` through them, and **silently disarmed negative control NC2.**

### Drift

`app.ensure_definer_policies()` runs on every deploy, so a table added by a
future migration is covered on the deploy that adds it. Three permanent tests
make drift a failed build rather than a failed launch:

- no FORCE-RLS table lacks a definer policy;
- no table enables row-level security without forcing it;
- the tables with **no** RLS at all are exactly `auth_otp_challenges`,
  `job_runs`, `provider_webhook_events`, `schema_migrations` — pinned by name, so
  a patient table shipped without RLS fails here.

---

## Definer / table privilege matrix

Derived from the function bodies. `!` marks `FORCE ROW LEVEL SECURITY`; `(W)`
writes, `(R)` reads. Bold marks tables that had **no** definer policy before
`0030`.

| Function | Tables |
|---|---|
| `register_with_password` | patient_profiles(W)! **user_credentials(W)!** **user_preferences(W)!** users(W)! |
| `find_or_create_user_by_phone` | patient_profiles(W)! **user_preferences(W)!** users(W)! |
| `find_user_for_password_login` | **user_credentials(R)!** users(R)! |
| `password_hash_for_user` | **user_credentials(R)!** |
| `set_password` / `record_login_failure` / `clear_login_failures` | **user_credentials(W)!** |
| `create_session` / `revoke_session` / `cleanup_expired_sessions` | auth_sessions(W)! |
| `rotate_session` / `session_is_live` | auth_sessions! users(R)! |
| `revoke_sessions_on_disable` | auth_sessions(W)! medications(R)! **push_tokens(W)!** |
| `consume_rate_budget` / `clear_rate_budget` / `purge_rate_buckets` | **auth_rate_buckets(W)!** |
| `accept_caregiver_invitation` | caregiver_relationships(W)! patient_profiles(R)! |
| `owns_profile` / `caregives_profile` / `has_permission` / `can_read_profile` | patient_profiles(R)! caregiver_relationships(R)! |
| `resolve_emergency_qr` | emergency_cards(W)! medications(R)! patient_profiles(R)! |
| `issue_otp` / `verify_otp` / `purge_expired_otp` | auth_otp_challenges (RLS not forced) |

Ten distinct FORCE-RLS tables are touched by definer functions; **four of them
had no policy**. Migration DML reaches two more (`dose_events` in `0025`,
`user_credentials`/`user_preferences` in the `0016`/`0017` backfills). `0030`
covers all twenty-six rather than these ten, because a migration's own DML is
subject to the same rule and enumerating "only what is needed today" is how the
`0008` list went stale.

Runtime grants are unchanged: `dawaee_app` holds table grants scoped by policy,
holds nothing at all on `user_credentials`; `dawaee_worker` holds exactly the
22-line manifest from `0021` across 16 tables, and nothing on `auth_sessions`,
`user_credentials`, `symptom_notes`, `emergency_cards`, `prescriptions` or
`audit_logs`.

---

## Test-harness change

`scripts/db-reset.sh` created `dawaee_test` as `postgres`. That is the root
cause's accomplice, and it is gone.

| | before | after |
|---|---|---|
| Database owner | `postgres` | `dawaee_migrator` |
| `rolsuper` | **true** | **false** |
| `rolbypassrls` | **true** | **false** |
| Migrations applied by | a bespoke loop in `db-reset.sh` | **`scripts/migrate.sh`** — the real deploy path |
| Reset cost | ~2.3 s × 19 files | **0.5 s** (template database, fingerprinted by the migration set) |

The privileged connection now does only what a non-superuser cannot do for
itself: create the three roles, grant the migrator `ADMIN` on the runtime roles
(`INHERIT FALSE, SET FALSE`), and set passwords. Schema, grants, default
privileges and definer policies are all applied as `dawaee_migrator`.

`scripts/db-bootstrap-roles.sh` refuses outright if the migrator is `SUPERUSER`
or `BYPASSRLS`, and a permanent test asserts both, because "someone made it a
superuser to get past an error" is the failure mode that would silently un-prove
every RLS test in the repository.

### What using the real deploy script immediately exposed

`scripts/migrate.sh` contained:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO dawaee_worker;
```

— handing the worker three privileges on **every table any future migration
creates**, undoing `0021`'s explicit 22-line manifest. `db-bootstrap-roles.sh`
had the matching `REVOKE`. Because only bootstrap ran in the harness and only
`migrate.sh` runs on deploy, **the two never disagreed anywhere anyone could
see, and production had the permissive one.** Corrected; `pg_default_acl` now
reads `dawaee_app=arwd/dawaee_migrator` and nothing for the worker.

---

## CI smoke change

The existing "Migrations as a non-superuser owner" job built the right kind of
database and never started the application against it. `scripts/managed-postgres-smoke.sh`
now does, and CI runs it after that job on the same database:

| Step | Proves |
|---|---|
| owner is `rolsuper=false rolbypassrls=false` | the smoke is not vacuous |
| `POST /v1/auth/register` → 200 | a definer WRITE across four FORCE-RLS tables |
| the credential row exists in SQL | registration did not report success without writing |
| `POST /v1/auth/login` → 200 | a definer READ (`app.find_user_for_password_login`) |
| `GET /v1/profiles` → 200 | an ordinary RLS read |
| `POST /v1/medications` → 200 | an ordinary RLS write |
| account B → account A's schedule → 403/404 | the tenancy boundary on this configuration |
| ledger rolled back to `0019`, process restarted | the startup gate refuses, exit 1, names the missing migrations, leaks no secret value |

---

## Schema startup contract

The contract is the **migration ledger**, not a list of function names. `db/migrations`
ships in the image, so the build carries the exact set — and md5 checksums — it
was written against. Every one must be present in `schema_migrations` with a
matching checksum.

| State | Verdict |
|---|---|
| behind (a required migration absent) | **refuse** |
| divergent (present, different checksum) | **refuse** |
| no ledger at all | **refuse**, distinctly |
| **ahead** (database knows migrations the build does not) | **allowed** — that is what a migrate-first deploy looks like, and P18 proved the old build serves correctly in that window |

`assertSchemaContract` runs in `apps/api/src/index.ts` **before anything binds a
port**. An unreachable database is retried (5 × 2 s), because a deploy
legitimately races the database coming back; a database that is reachable and
behind is **not** retried, because waiting cannot fix it and a slow failure is
worse than a fast one.

`/health` stays pure process liveness. `/health/ready` gained a `schema` check
and returns 503 `degraded` when it fails — in practice that catches a database
moving *backwards* under a running instance (a restore, a failover onto a stale
replica), since startup refuses the behind case outright.

**`render.yaml`'s `healthCheckPath` was deliberately left on `/health`.** Pointing
a platform health check at a dependency-sensitive endpoint means a database blip
restarts every instance at once, which converts a recoverable outage into a
thundering herd. That trade-off deserves its own decision, not a side effect of
this change.

Measured, with a real `0019` database:

```
fatal startup error: database schema is incompatible with this build
  (not applied: 0020_notification_privacy.sql, … 0030_definer_privilege_model.sql)
this build requires the database to be migrated to 0030_definer_privilege_model.sql;
  run scripts/migrate.sh before starting the API
exit 1 — no port bound
```

---

## Migrate preflight

Everything that can refuse now refuses **before the first migration is applied**.
`./scripts/migrate.sh --preflight-only` runs the checks and exits.

| Check | Refuses when |
|---|---|
| connection | `DATABASE_URL` is unreachable |
| migration role | it is `dawaee_app` or `dawaee_worker` — migrating as a runtime role would make it the owner and hand it the exemption |
| role administration | the role cannot set the runtime roles' passwords (PG16+ needs `ADMIN`), which the old script discovered *after* committing ten migrations |
| definer policies | a runtime role could reach the exemption, or the tables are owned by somebody else |

Reproduced deliberately: a migration role with no `ADMIN` on the runtime roles
now fails at the preflight with an actionable message and **`tables=0`** — the
schema untouched — where the old script committed nineteen migrations first.

The self-`GRANT` is not eliminated, because it is not gratuitous: Render supplies
both runtime passwords as environment variables and `migrate.sh` is what writes
them into PostgreSQL, which is exactly what keeps the value Render hands each
service and the value in the database the same by construction. What changed is
that the prerequisite is now checked first, and can be opted out of entirely by
unsetting both passwords. `docs/RUNBOOK-migrate-preflight.md` covers both paths.

---

## Version traceability

`/version` now resolves the commit as `RENDER_GIT_COMMIT` → `GIT_COMMIT` →
`unknown`. Render sets the first itself, from the commit it built, so a Render
deploy reports its real SHA with no build argument to maintain and nothing to go
stale. Both inputs are validated as hex before being echoed, so an arbitrary
environment value cannot be reflected through an unauthenticated endpoint.

Verified live:

```
RENDER_GIT_COMMIT=abc1234…  GIT_COMMIT=1111111…
  → {"service":"dawaee-api","commit":"abc1234def5678901234567890abcdef12345678",
     "version":"unknown","builtAt":"unknown","schema":"0030_definer_privilege_model.sql"}
```

A malformed platform value does not shadow a good build argument. `schema` is
the migration this build requires — a property of the artefact, not of the
database it is pointed at.

---

## TRUST_PROXY_HOPS

Declared in `render.yaml` as `"1"` with the reasoning written next to it. It was
not in that file at all, so a security-sensitive topology assumption existed only
as a default in `config.ts`.

**This does not make production header semantics a PASS.** Live Render
`X-Forwarded-For` verification remains **NOT RUN** until measured against a real
request. The service already logs a warning when the resolved client address
lands in a private range, which is the signal that the value is wrong; that
warning fired during this work and is quoted in the evidence below.

---

## Results

### Fresh PostgreSQL 17 — `0001` → `0030`

Owner `dawaee_migrator`, `rolsuper=false`, `rolbypassrls=false`.

| | |
|---|---|
| First run | **PASS**, 30 files applied, exit 0 |
| Second run | **PASS**, `no pending migrations`, exit 0 |
| RLS probe | **30 PASS, 0 FAIL** |
| Invalid indexes / unvalidated constraints | **0 / 0** |
| FORCE-RLS tables without a definer policy | **0** |

### Upgrade — `0019` → `0030` on a realistic owner, with seeded data

Seeded through the **baseline API over HTTP** — 5 users, 5 profiles, 4
medications, 8 schedules, 126 dose occurrences, 6 sessions, 5 credentials, 2
caregiver relationships, 21 audit rows — plus the two race states the migrations
exist to clean up.

| | |
|---|---|
| Result | **PASS**, exit 0, **0.90 s**, 11 migrations |
| Second run | **PASS**, `no pending migrations` |
| Tables unchanged in row count | **27 of 30** |
| `dose_events` | 14 → 10 — exactly the 4 duplicate `missed`; each occurrence now has **1**; all 4 legitimate `snoozed` preserved |
| `auth_otp_challenges` | count **unchanged**; live-per-phone 4 → 1 and 2 → 1; the pre-consumed row untouched |
| `schema_migrations` | 19 → 30 |
| `auth_rate_buckets` | created, empty |
| Users, credentials, profiles, medications, schedules, dose occurrences, caregivers, sessions, stock | **byte-identical** (full row-level diff) |
| Invalid indexes / unvalidated constraints | **0 / 0** |
| Worker privileges | 16 tables, exactly the `0021` manifest; **no** `auth_sessions`, `user_credentials`, `symptom_notes`, `emergency_cards`, `prescriptions`, `audit_logs` |
| Worker default ACL for future tables | **none** (was `SELECT, INSERT, UPDATE` on everything) |
| Housekeeping as `dawaee_worker` | all three functions execute |

**Without `0030`, this same upgrade aborted at `0025`** with `0020`–`0024`
committed. That is the difference the migration makes.

### The three-state matrix

| State | Result |
|---|---|
| **OLD `db7061f` + schema `0030`** | **41/44** — the three failures are the known baseline defects the RC fixes (P12 profile-creation 404; wrong-current-password accepted; the resulting takeover), all reproduced on `0019` too. Nothing new broken. Migration-first remains valid. |
| **RC + schema `0019`** | **STARTUP REFUSED** — exit 1, no port bound, migrations named, no secret leaked |
| **RC + schema `0030`** | **44/44**, on a fresh database and again on the upgraded one carrying pre-existing data. Worker: 0 permission denials. |

### Full regression

| | PostgreSQL 16.13 | PostgreSQL 17.10 |
|---|---|---|
| Test files | 47 passed / 47 | 47 passed / 47 |
| Tests | **1056 passed** | **1056 passed** |
| Failed | 0 | 0 |
| Skipped | 0 | 0 |
| Duration | 212.17 s | 208.34 s |
| Exit | 0 | 0 |

Both versions run against the **non-superuser, non-BYPASSRLS** topology. Suite
grew 1013 → 1056: 30 definer-privilege-model tests, 12 schema-contract tests,
one Dockerfile gate; three existing assertions were rewritten rather than
deleted, and one existing test was fixed.

**One intermittent, found and fixed.** The first PG17 run failed
`two concurrent materializations cannot both insert the same dose` on a 30 s
timeout. It passed in isolation (73/73) and on re-run (1055/1055), but the cause
was real and in the test, not the product: it issued two racing INSERTs and then
awaited *A* before committing A. Which writer reaches the unique index first is
not ordered, so whenever B won, A blocked on B's uncommitted tuple while B's
`COMMIT` sat queued behind an `await` that could never return. PostgreSQL cannot
see a cycle that runs through the client, so it simply hung. Each writer now
commits as soon as its own insert returns; three consecutive runs, ~1 s each.

### Builds

| | |
|---|---|
| `npm run typecheck` | PASS |
| `npx eslint .` (root and mobile) | PASS, 0 findings |
| API + worker production build | PASS |
| Mobile `tsc --noEmit` | PASS |
| Mobile production export | PASS — iOS 3.90 MB, Android 3.91 MB, web 1.66 MB |
| Production Docker image | **NOT RUN** — registry blocked (403), no Docker daemon |

---

## Negative controls

Each mutation is rolled back or explicitly undone. The point is not to test
PostgreSQL; it is to show that if the control were absent, something would
actually break.

| # | Control removed | Observed |
|---|---|---|
| NC1 | `user_credentials_definer` policy | `app.register_with_password` → **SQLSTATE 42501**, `row-level security policy for table "user_credentials"` |
| NC2 | `dose_events_definer` policy, with real duplicates seeded and the guard index dropped | the dedup `DELETE` matched **0 rows** with no error, the table read as **empty**, and `CREATE UNIQUE INDEX` then failed on duplicate keys — the exact deploy abort, reproduced on demand |
| NC3 | a blanket `TO dawaee_app USING (true)` policy, **committed** so a separate connection could see it | `dawaee_app` went from **0** visible `patient_profiles` to **all** of them; dropped afterwards and confirmed back to 0 |
| NC4 | a policy created with no `TO` clause | detected as `TO PUBLIC` by the same query `0030` uses |
| NC5 | — | `pg_has_role` distinguishes: true for the owner about itself, false for `dawaee_app` about the owner. The check is not vacuous. |
| NC6 | — | the owner's `rolbypassrls` is **false**, without which NC1 and NC2 cannot fail and prove nothing |
| NC7 | migration role with no `ADMIN` on the runtime roles | preflight refuses with an actionable message and **`tables=0`** — nothing applied |
| NC8 | `SET ROLE dawaee_migrator` attempted as each runtime role | refused at runtime, not merely absent from the catalogue |

The measurement that justifies `INHERIT FALSE, SET FALSE` is itself a negative
control: with plain `WITH ADMIN OPTION`, NC2 **stopped firing**, because the
owner was reading `dose_events` through `dawaee_worker`'s inherited policy.

---

## Blockers

### Closed by this work

- definer policies missing on 20 of 26 FORCE-RLS tables — **CLOSED** (`0030`,
  the sweep, three drift tests)
- the upgrade aborting at `0025` on a realistic owner — **CLOSED**
- the test harness proving RLS properties against a superuser — **CLOSED**
- a migration-only CI pass — **CLOSED** (managed-Postgres smoke)
- new code booting healthy against an old schema — **CLOSED** (startup gate)
- `migrate.sh` half-applying before discovering it cannot administer roles —
  **CLOSED** (preflight)
- `migrate.sh` granting the worker default privileges on every future table —
  **CLOSED** (found by the harness change)
- `0021` creating a `TO PUBLIC` policy — **CLOSED** (found by `0030`)
- `/version` unable to name the running commit on Render — **CLOSED**
- `TRUST_PROXY_HOPS` undeclared — **CLOSED as configuration**

### Still open — external, and not converted by any repository test

| | Status |
|---|---|
| GitHub `main` branch protection | **CONFIRMED MISSING** |
| GitHub Actions execution on the RC | **NOT RUN** |
| Exact production Docker image | **NOT RUN** — registry blocked locally |
| Native signed mobile build | **NOT RUN** |
| Real-device mobile tests | **NOT RUN** |
| Live Supabase TLS | **NOT RUN** |
| Live Render `X-Forwarded-For` semantics | **NOT RUN** |
| Push provider | **MOCK** |
| OTP delivery | **NOT IMPLEMENTED** (deliberate 503) |
| Live storage / OCR | **NOT VERIFIED** |
| `buildNumber` / `versionCode` | both still `1` |
| Retention policy approval | **POLICY MISSING** |
| Registration enumeration | **PROPOSED ACCEPTED RISK** |
| Emergency `patientName` disclosure | **DECISION PENDING** |
| Saudi PDPL applicability | **NOT ASSESSED** |

### One new item, recorded rather than hidden

`0021`, `0025` and `0030` change the migration set. Any database that already
applied `0021` or `0025` — every developer laptop and CI cache — will be refused
by the ledger's checksum guard until it is rebuilt with `scripts/db-reset.sh`.
This is correct behaviour and costs one command. **Production is unaffected: its
ledger stops at `0019`, so no shipped migration was edited.** Verified by
`md5sum` diff across `0001`–`0019` against the deployed baseline: identical.
