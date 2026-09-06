# P18 — release candidate rehearsal

Executed 2026-09-06. **Nothing was deployed, pushed, or run against production.**
No Render service was created, changed or deleted; no production migration ran;
no environment variable was written; no provider credential was enabled.

| | |
|---|---|
| Audit baseline (what production runs) | `db7061f1ae8fc52a02d68aea76da8a46ff382b04` |
| Release candidate (code) | `1cafd5a708d38cc2ff56050e1439ca6ed1d055c1` |
| Documentation head | `daec9ae9308e3afd0b29370f6c5e77063e2400fd` |
| Working tree | clean |
| Baseline → RC | 113 files, +20 152 / −380, 30 remediation commits, 10 migrations |

---

## The blocker

**`app.register_with_password` cannot write `user_credentials` when the
migration-runner role lacks `BYPASSRLS`. Registration returns 404/500 and the
product is unusable from its first request.**

Measured, not inferred. Two databases, identical schema `0029`, differing only in
one role attribute:

| Owner of the tables and the SECURITY DEFINER functions | `POST /v1/auth/register` |
|---|---|
| `postgres` — superuser, `rolbypassrls = t` (what every test runs against) | **200** |
| `ci_owner` — `rolsuper = f`, `rolbypassrls = f` (a managed Postgres) | **404** |

The refusal, read directly in SQL:

```
ERROR:  new row violates row-level security policy for table "user_credentials"
CONTEXT: SQL statement "INSERT INTO user_credentials (user_id, password_hash) …"
         PL/pgSQL function register_with_password(text,text,text,text,text) line 24
```

### Why

Migration `0008` diagnosed this exact hazard and fixed it. Its own comment says:

> A SECURITY DEFINER function runs as the role that owns it — here, the role that
> runs migrations, which also owns the tables. Under FORCE ROW LEVEL SECURITY the
> owner is NOT exempt, so on any cluster where that role is not a superuser
> (which is every managed Postgres, including the deployment target) these
> predicates would read zero rows and deny every request.

The fix is a hand-written array of seven table names:

```sql
FOREACH t IN ARRAY ARRAY[
  'users', 'patient_profiles', 'caregiver_relationships',
  'auth_sessions', 'auth_otp_challenges', 'medications', 'emergency_cards'
]
```

Six of those seven carry `FORCE ROW LEVEL SECURITY` and are covered.
`auth_otp_challenges` does not force it, so the owner is exempt there anyway.

**Twenty further tables carry `FORCE ROW LEVEL SECURITY` and have no such
policy** — 26 forced tables in total, 6 covered, 20 not. Every one of the twenty
was created after `0008`, and the array was never extended:

```
audit_logs                  auth_rate_buckets (0029)   caregiver_notification_rules
consents                    dose_events                dose_occurrences
escalation_policies         health_measurements        medication_schedules
medication_stock            notification_deliveries    prescriptions
push_tokens                 refill_events              stock_transactions
stored_objects              symptom_notes              travel_prompts
user_credentials (0016)     user_preferences
```

`user_credentials` is the one that fires first, because registration is the first
thing anyone does.

### Why 1013 tests did not catch it

`scripts/db-reset.sh` creates `dawaee_test` as `postgres`, a superuser. Every
table and every `app.*` SECURITY DEFINER function is therefore owned by a role
that bypasses RLS unconditionally. The entire suite proves its properties against
a database configured in a way the deployment target is not.

CI's "Migrations as a non-superuser owner" job creates exactly the right kind of
database — `ci_owner`, `CREATEDB CREATEROLE`, no superuser — and then runs only
`migrate.sh` and the RLS probe against it. **The application is never started
against that database**, so the gap survived P8, P12, P15 and P16.

### What must happen before release

One of:

1. **Read the fact.** Connect as the production `DATABASE_URL` and run
   `SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;`
   If `rolbypassrls` is true, production works today — but by an undocumented
   accident of the platform, and the release should still record it as a
   requirement rather than leave it implicit.
2. **Remove the dependency.** A migration that generates the definer policy for
   every `FORCE ROW LEVEL SECURITY` table in `public`, derived from the catalogue
   rather than a hand-kept list, so a table added tomorrow cannot reintroduce it.
3. **Close the test gap** either way: start the API against the
   non-superuser-owned database CI already builds, and run at least registration
   and one authenticated read against it. A property nothing exercises is not a
   property.

Classification: **SECURITY / CORRECTNESS RELEASE BLOCKER — CONFIRMED.**

---

## 1. Release candidate freeze

Working tree clean at `daec9ae`. Remediation commits between baseline and RC, oldest first:

```
9f55a65 Enforce the app lock that was reporting itself as on
45dfec3 Close the app lock's own bypass, and stop exempting the emergency card
707e753 Move session tokens out of AsyncStorage and into the keychain
5c4941e State the keychain accessibility class, and stop Android backing up credentials
e0731bb Encrypt the local medication cache, per account, with AES-256-GCM
20417f7 Move the low-stock snooze into the encrypted store, and file the notification finding
5604c01 Verify the database certificate, or refuse to start
c16c55d Stop naming medications in notifications unless the patient asks
08e2162 Execute the adversarial RLS matrix against the runtime role
324a981 Give the worker exactly the privileges it uses, and fix the housekeeping it broke
3999a16 Close two account-takeover holes in the password change, and prove rotation is race-safe
4f1cf7a Stop disabled accounts, stop punishing refresh races, and correct the scrypt cost
2696760 Make account disablement permanent, and recover a lost refresh across restarts
a5b8c95 Audit worker reliability by execution, and stop one cleanup failure killing the rest
121b603 P10: worker idempotency, delivery leases, and patient-local date arithmetic
dfd0a1b P14: gitignore .npmrc so a developer credential file cannot be committed
c257eb6 P15: Docker — SIGTERM never reached node, plus build-context and image hardening
efddfdd P5: identity enumeration — a forged header defeated every rate limit
5774f46 P6: OTP — the stored verifier was reversible, and two codes could be live at once
20312ed P7: authentication limits that survive a replica and a cold start
9818465 P7: make two limiter tests key-scoped instead of reading the newest row
3fbbc78 P11: the emergency token was written to the logs in plaintext
2c97474 P12: endpoint-wide authorization audit, with the defects it found
73f3ea7 P12: caregiver permission matrix and disabled-account sweep over HTTP
7aa84f7 P12: constant-time local signature check, and a date filter that was ignored
d863306 P13: what the logs actually contain, and a foreign key that was not a check
8fb4936 Caregiver routes ask for the permissions their queries actually read
6e7c106 P13: operational error sanitizer, audit-trail evidence, retention runbook
1cafd5a P16: CI security gates, PostgreSQL 17 parity, and release traceability
daec9ae P17: production release and Render cleanup runbooks
```

**Migrations 0001–0019 are byte-identical to the baseline.** `md5sum` diff over
all nineteen files: no difference. The production ledger will therefore accept
the release — `migrate.sh`'s immutability check cannot fire.

---

## 2. Migration matrix (0020 → 0029)

Locking measured inside each migration's own transaction by reading `pg_locks`
for `pg_backend_pid()` before commit. Duration measured on a seeded database.

| # | Purpose | DDL | DML | Heaviest lock | Backward-compatible with `db7061f`? | Rollback |
|---|---|---|---|---|---|---|
| 0020 | notification privacy: opt in before a medication is named | `ADD COLUMN show_medication_in_notifications DEFAULT false` | — | `user_preferences` AccessExclusive (brief — constant default, no rewrite) | yes, old code ignores the column | additive; leave in place |
| 0021 | worker least privilege + `cleanup_expired_sessions` | REVOKE ALL then 22 explicit GRANTs; replace `caregiver_rel_update` policy | — | `caregiver_relationships` AccessExclusive | **see note below** | additive; grants only narrow |
| 0022 | `app.password_hash_for_user(uuid)` | CREATE FUNCTION | — | none | yes, old code never calls it | drop-safe, not dropped |
| 0023 | disabled accounts and superseded sessions | CREATE OR REPLACE `session_is_live`, `rotate_session` | — | none | yes — verified by execution | replaced in place |
| 0024 | disabling an account revokes its sessions | CREATE TRIGGER on `users` | — | `users` ShareRowExclusive (blocks writes, not reads) | yes | drop trigger |
| 0025 | one missed event per dose | `CREATE UNIQUE INDEX … WHERE type='missed'` | **DELETE** duplicate `missed` rows | `dose_events` ShareLock + index AccessExclusive | yes | **irreversible DELETE** |
| 0026 | delivery lease | `ADD COLUMN lease_until, lease_token`; partial index | — | `notification_deliveries` AccessExclusive + ShareLock | yes | additive |
| 0027 | a lockout does not slide | CREATE OR REPLACE `record_login_failure` | — | none | yes | replaced in place |
| 0028 | one live OTP challenge per phone | `CREATE UNIQUE INDEX … WHERE consumed_at IS NULL` | **UPDATE** surplus live challenges to consumed | `auth_otp_challenges` ShareLock + index AccessExclusive | yes | **irreversible UPDATE** |
| 0029 | shared auth rate limit | CREATE TABLE `auth_rate_buckets` + RLS + 3 functions | — | new table only | yes, old code never reads it | drop-safe, not dropped |

**Total measured duration, whole set, on a seeded database: 0.75 s.**

Two scaling caveats, neither triggered here:

- `0025` and `0028` build unique indexes **without** `CONCURRENTLY`, so writes to
  `dose_events` and `auth_otp_challenges` block for the build. On a large
  `dose_events` table that window grows with row count. Production has no traffic,
  so today it is irrelevant; it will not stay irrelevant.
- `0021` revokes every worker privilege and re-grants an explicit 22-line
  manifest, inside one transaction. **A running old worker loses any privilege
  not on that list the moment the transaction commits.** Measured: the old worker
  survives, because the tables it actually reads are all on the list — but this is
  the one migration in the set that can take something away, and it is the reason
  the runbook deploys the worker immediately after migrating rather than leaving
  the old one running.

No `DROP TABLE`, no `DROP COLUMN`, no `TRUNCATE`, no type narrowing anywhere in
the set.

---

## 3. Fresh database — PostgreSQL 17

PostgreSQL **17.10**, database created by and owned by a **non-superuser**
(`ci_owner`, `CREATEDB CREATEROLE`), migrated with the real `scripts/migrate.sh`.

| Check | Result |
|---|---|
| `0001` → `0029` from zero | **PASS** — `applied 29 migration(s)`, exit 0 |
| Second run is a no-op | **PASS** — `no pending migrations`, exit 0 |
| `db/seed/rls_probe.sql` | **PASS** — 30 PASS, 0 FAIL |
| Full suite against it | **PASS** — 45 files, **1013 tests**, 229.29 s, exit 0 |

This is the first execution of the suite against PostgreSQL 17 — the production
major version. P16 configured the matrix; P18 ran it.

**One finding from this step**, separate from the blocker: `migrate.sh`'s
role-grant block runs `ALTER ROLE dawaee_app WITH PASSWORD …`. Since PostgreSQL
16, a `CREATEROLE` role may only alter roles it created. If `dawaee_app` and
`dawaee_worker` were ever created in production by a **different** role than the
one in `DATABASE_URL`, this fails:

```
ERROR: permission denied to alter role
DETAIL: To change another role's password, the current user must have the
        CREATEROLE attribute and the ADMIN option on the role.
```

`migrate.sh` runs under `set -euo pipefail`, so that failure exits non-zero —
**inside the worker's `preDeployCommand`**, failing the deploy. Reproduced
deliberately, then confirmed to pass when the roles are created by the migration
runner itself (which is what `0008` does on a fresh database).

---

## 4. Upgrade — production-shaped `0019` database → `0029`

A database migrated to `0019` by the **baseline's own** `migrate.sh`, then seeded
through the **baseline API over HTTP** — real users, real profiles, real
medications, real dose confirmations — plus rows written directly for the two
races the migrations exist to close, because no application path can produce
those any more.

Pre-upgrade: 4 users, 4 profiles, 4 medications, 8 schedules, 130 dose
occurrences, 19 dose events (8 `missed` across 4 occurrences, two of them with 3
each; 4 legitimate repeated `snoozed`), 7 OTP challenges (6 live across 2 phones —
one with 4, one with 2 — and 1 already consumed), 5 sessions, 4 credentials,
30 job runs, 1 caregiver relationship, 1 emergency card.

| Check | Result |
|---|---|
| `migrate.sh` `0020`→`0029` | **PASS**, exit 0, **0.75 s** |
| Tables whose row count changed | **3 of 29** |
| `dose_events` | 19 → 15 — exactly the 4 duplicate `missed` rows; each of the 4 occurrences now has **1**; all 4 `snoozed` rows survived |
| `auth_otp_challenges` | count **unchanged** (0028 updates, never deletes); live-per-phone 4 → 1 and 2 → 1; the pre-consumed row untouched |
| `schema_migrations` | 19 → 29 |
| `auth_rate_buckets` | created, empty |
| Users, profiles, medications, schedules, dose occurrences, caregiver relationships, sessions, credential hashes, stock | **byte-identical** — full row-level diff, no difference |
| Relationships preserved | **PASS** — every foreign key row matched by id |
| `show_medication_in_notifications` | default `false`, **0 NULL rows** — existing accounts default to the private setting |
| `lease_until` / `lease_token` | present |
| New functions present | 5 of 5 |
| Invalid indexes | **0** |
| Unvalidated constraints | **0** |
| `users_revoke_sessions_on_disable` trigger | present |

### Worker privileges after the upgrade

Exactly the `0021` manifest and nothing more:

```
caregiver_notification_rules SELECT          medication_stock         SELECT,UPDATE
caregiver_relationships      SELECT,UPDATE   medications              SELECT,UPDATE
dose_events                  INSERT          notification_deliveries  SELECT,INSERT,UPDATE,DELETE
dose_occurrences             SELECT,UPDATE   patient_profiles         SELECT
escalation_policies          SELECT          provider_webhook_events  SELECT,UPDATE,DELETE
job_runs                     SELECT,INSERT,UPDATE,DELETE              push_tokens  SELECT,UPDATE
medication_schedules         SELECT          stored_objects           SELECT,DELETE
user_preferences             SELECT          users                    SELECT
```

`auth_sessions`, `user_credentials`, `symptom_notes`, `emergency_cards`,
`prescriptions`, `audit_logs`: **no access at all**.

### Housekeeping, executed as `dawaee_worker`

The P8/P10 finding was that housekeeping had never run — `permission denied for
table auth_sessions`, which P17 measured still happening in production every hour.
Run as the worker role against the upgraded database, with rows deliberately aged:

```
app.cleanup_expired_sessions(30) -> 1     auth_sessions   5 -> 4
app.purge_expired_otp(7)         -> 1     otp challenges  8 -> 7
app.purge_rate_buckets(24)       -> 0     (nothing to purge)
```

**PASS** — and this is the observable that will confirm `0021` landed in
production: the hourly `permission denied` line stops.

---

## 5. Old code against the new schema

The baseline binary (`db7061f`, built from its own worktree) pointed at the
upgraded `0029` database, driven through 44 product assertions.

**41 of 44 passed.** The three failures are all pre-existing baseline defects
that the RC fixes, and none is caused by the migrations:

| Failure | Cause |
|---|---|
| `POST /v1/profiles` → **404** | The P12 defect: a STABLE definer predicate in the SELECT policy cannot see the row its own statement is inserting, so `RETURNING` finds nothing. Present on `0019` too. |
| `POST /v1/auth/password` with a **wrong current password** → **200 `{"updated":true}`** | The account-takeover hole closed by `3999a16`. |
| Signing in with the attacker's new password → **200** | Consequence of the above. **TAKEOVER CONFIRMED.** |

The takeover was reproduced on a **`0019`** database as well — old code, old
schema, same result — so it is a property of the deployed code, not of the
migrations.

Everything else the old code needs works against `0029`: login, refresh rotation,
`/v1/today`, medications, dose taken/undo, caregiver invite, emergency QR enable
and scan, cross-tenant refusal, logout. The worker tick also runs.

**Conclusion: the migration-first release sequence is VALID.** Migrations
`0020`–`0029` can be applied while `db7061f` is still serving.

---

## 6. New code against the old schema

The release candidate pointed at an untouched `0019` database.

| Probe | Result |
|---|---|
| Process boots | **yes** |
| `GET /health` | **200 `{"status":"ok"}`** |
| `GET /health/ready` | **200 `{"status":"ready"}`, `checks.database.ok: true`** |
| `POST /v1/auth/register` | **500** |
| `POST /v1/auth/login` ×12 from one address | **500 ×12** |
| Same 12 requests on `0029` (control) | 401 ×9 then **429 `rate_limited`** with `retryAfterSeconds` |

Two conclusions, and they point opposite ways.

**Good: it fails closed.** A missing `app.consume_rate_budget` does not degrade
into an unlimited-attempt path and a missing `app.password_hash_for_user` does not
degrade into an unchecked one. Nobody signs in, nobody bypasses the limiter, no
request is served incorrectly. There is no silent wrong behaviour anywhere in the
measured surface.

**Bad: nothing notices.** `/health` — which is what `render.yaml` uses as
`healthCheckPath` — returns 200. `/health/ready` returns 200 as well, because it
runs `SELECT 1` and asks nothing about the schema the code needs. Render would
mark the service live and route traffic to an API where **100 % of authentication
requests return 500**.

That is the measured justification for API-last ordering, and it is also a finding
in its own right: **readiness does not check schema compatibility.** A cheap fix —
having `/health/ready` assert the presence of the `app.*` functions the build
depends on — would turn a silent 500-storm into an honest 503.

---

## 7. Full regression

| | PostgreSQL 17.10 | PostgreSQL 16.13 |
|---|---|---|
| Test files | 45 passed / 45 | 45 passed / 45 |
| Tests | **1013 passed** | **1013 passed** |
| Failed | 0 | 0 |
| Skipped | 0 | 0 |
| Duration | 229.29 s | 255.77 s |
| Exit | 0 | 0 |

No unexplained failures on either major version. No divergence between them.

PostgreSQL 17 was obtained as a self-contained binary distribution because the
PGDG apt repository and every container registry are blocked by this
environment's egress policy. Client tooling is `psql` 16 against the 17 server;
the migration path uses only `\i`, `-c`, `-f` and `--single-transaction`, none of
which is version-sensitive.

---

## 8. Security regression matrix

| Phase | Security property | Permanent test | Status |
|---|---|---|---|
| P1–P3 | Session tokens never in AsyncStorage; keychain accessibility class stated; Android backup off | `apps/mobile/test/token-store.test.ts` (37) | **PASS** |
| P1–P3 | Medication cache encrypted per account; two accounts on one phone cannot reach each other | `apps/mobile/test/secure-cache.test.ts` | **PASS** |
| P1–P3 | App lock cannot be bypassed; the emergency card is not exempt | `apps/mobile/test/app-lock.test.ts` | **PASS** |
| P4 | Database certificate verified, or the service refuses to start | `apps/api/test/db-tls.test.ts`, `config.test.ts` | **PASS** (not named in the release-gate manifest — see gap below) |
| P5 | Identity enumeration; a forged `X-Forwarded-For` cannot defeat the limiter | `apps/api/test/identity-enumeration.test.ts` | **PASS** |
| P6 | OTP verifier is irreversible; one live challenge per phone | `apps/api/test/otp-security.test.ts` (26) | **PASS** |
| P7 | Auth limits survive a replica and a cold start | `apps/api/test/shared-rate-limit.test.ts` | **PASS** |
| P8 | Worker privilege boundary | `apps/api/test/privilege-boundary.test.ts` | **PASS** |
| P8 | Patient A cannot reach Patient B, by any route the database exposes | `apps/api/test/rls-matrix.test.ts` (36) + `db/seed/rls_probe.sql` | **PASS** |
| P9 | Refresh rotation has one winner; disabled accounts stay disabled | `apps/api/test/auth-session.test.ts` | **PASS** |
| P9 | Password change requires the current password; scrypt cost | `apps/api/test/password-auth.test.ts` | **PASS** |
| P9 | Mobile refresh is single-flight | `apps/mobile/test/refresh-single-flight.test.ts` | **PASS** |
| P10 | Worker idempotency, delivery leases, patient-local dates, 7 crash windows | `apps/api/test/worker-reliability.test.ts` | **PASS** |
| P11 | Upload signature and emergency-card disclosure | `apps/api/test/upload-emergency-security.test.ts` | **PASS** |
| P11 | Notifications do not name a medication unless the patient opts in | `apps/api/test/notification-privacy.test.ts` | **PASS** |
| P12 | Endpoint-wide authorization; caregiver permission ceiling; BOLA matrix | `apps/api/test/endpoint-authorization.test.ts` (~70) | **PASS** |
| P13 | Log redaction | `apps/api/test/log-redaction.test.ts` (16) | **PASS** |
| P13 | Operational errors persisted to `job_runs` carry no raw text | `apps/api/test/operational-error-privacy.test.ts` (13) | **PASS** |
| P13 | Audit-log integrity and authorization | `apps/api/test/audit-privacy.test.ts` (22) | **PASS** |
| P14 | `.npmrc` cannot be committed | `.gitignore` + `release-gates.test.ts` artefact check | **PASS** (static assertion only) |
| P14 | Dependency advisories held to a threshold | `scripts/audit-gate.mjs`, CI `dependencies` job | **NOT RUN in CI** (the workflow has never executed) |
| P15 | Container: non-root, `exec` PID 1, no dev dependencies, no secrets in the image | `release-gates.test.ts` static checks + `scripts/container-checks.sh` | **PARTIAL** — static assertions PASS; the image has never been built |
| P16 | Every security suite is still in the tree and still named | `apps/api/test/release-gates.test.ts` (29) | **PASS** |
| P16 | The CI configuration keeps its security properties | `release-gates.test.ts` | **PASS** (configuration only) |

### Gaps in the manifest

Three remediations exist only as one-time audit experiments or as static
assertions, with no permanent executed test:

1. **P15 container behaviour.** `container-checks.sh` asserts the real properties
   — non-root user, `exec` as PID 1, SIGTERM handled, no dev dependencies — but it
   requires a built image, and no image has ever been built under test. The
   repository checks are string assertions about the `Dockerfile`.
2. **P14 dependency gate.** `audit-gate.mjs` is correct and complete, and has
   never run in CI.
3. **P4 database TLS** is covered by `db-tls.test.ts` but is **not in the
   release-gate manifest**, so deleting that file would not fail the build. Every
   other phase's suite is protected; this one is not.

---

## 9. Builds

| Build | Result |
|---|---|
| `npm run typecheck` (all workspaces) | **PASS**, exit 0 |
| `npx eslint .` | **PASS**, exit 0, no findings |
| API + worker production build (`tsc -b`, clean) | **PASS** |
| Mobile `tsc --noEmit` | **PASS**, exit 0 |
| Mobile production export (`expo export --platform all`) | **PASS** — iOS 3.90 MB, Android 3.91 MB Hermes bundles, web bundle, 9.5 MB total |
| `expo-doctor` | 13 / 18 passed — 4 failed on blocked network, 1 genuine (see below) |
| **Production Docker image** | **NOT RUN** — registry blocked (`CONNECT tunnel failed, 403`) and no Docker daemon in this environment |

The one substantive `expo-doctor` finding is
`resolver.disableHierarchicalLookup` set to `true` in `metro.config.js`. That is
the standard Expo monorepo pattern, paired with an explicit `nodeModulesPaths`,
and it is required here because `apps/mobile` is deliberately not a workspace
member. The export succeeding for all three platforms is the evidence that the
override is correct. **Accepted deviation, not a defect.**

`npx tsc -b` does not recover from a hand-deleted `dist` without `--clean`. Not a
release issue — the container build starts from an empty context — but worth
knowing before someone debugs it at 2 a.m.

### The shipped mobile bundle

Scanned directly, after export:

| Looked for | Found |
|---|---|
| `JWT_SECRET`, `IP_HASH_SALT`, provider keys, storage secrets, any `postgres://`, any private key | **0** |
| Sentry / Bugsnag / Datadog / Mixpanel / Firebase Analytics / Google Analytics | **0** |
| Analytics packages in `package.json` | **none** |

One `amplitude` string appears in the bundle. It is the SVG
`feComponentTransfer` attribute, from `react-native-svg`. P13's finding that the
app has no telemetry sink at all holds for the release candidate's actual build
artefact, not just its source.

---

## 10. Mobile release candidate

| Requirement | Value |
|---|---|
| `expo-secure-store` | `~14.0.1` — present |
| `expo-crypto` | `~14.0.2` — present |
| `android.allowBackup` | **`false`** |
| `expo-local-authentication` | `~15.0.2` — present |
| `version` | `0.1.0` |
| `ios.buildNumber` | **`1`** |
| `android.versionCode` | **`1`** |
| Bundle id / package | `app.dawaee.mobile` |

`buildNumber` and `versionCode` have **never been incremented**. Both stores
reject a resubmission at an already-used build number, so both must be bumped
before submission, and `version` should name the release.

**Native signed build: NOT RUN.** No EAS credentials, no signing material, and no
network path to the build service in this environment.

---

## 11. Mobile data migration rehearsal

Every scenario the phase asked for is covered by permanent tests, executed in both
suite runs, against mocked `AsyncStorage` and `SecureStore` — **not on a device**.

| Scenario | Test | Result |
|---|---|---|
| Legacy AsyncStorage tokens adopted | "adopts the legacy pair and wipes it" | PASS |
| SecureStore wins over a stale legacy copy | "never lets an older legacy token overwrite a newer keychain one" | PASS |
| Legacy secrets removed | "removes the keychain entry and both legacy keys" | PASS |
| Medication cache encrypted on adoption | "adopts it, encrypts it, and destroys the plaintext" | PASS |
| Offline queue preserved | "preserves order and every field across a restart"; "does not duplicate mutations when migrating a plaintext queue" | PASS |
| Low-stock snooze preserved | "migrates a legacy per-medication key and deletes it"; "never lets a stale legacy key override newer encrypted state" | PASS |
| User A cannot leak into User B | "two accounts on one phone cannot reach each other"; "User A logout → User B login → nothing of A remains readable" | PASS |
| Interrupted migration resumes safely | "resumes an interrupted migration on the next launch"; "recovers when the process died between the write and the delete"; "cleans up the leftover when the process died after the write" | PASS |
| Migration never falls back to plaintext on failure | "keeps the plaintext when the ciphertext write fails"; "reports a failed ciphertext write without falling back to plaintext" | PASS |
| SecureStore unreadable | "does not silently mint a replacement when the store is unreadable"; "does not resurrect a plaintext token when the keychain is unreadable" | PASS |

---

## 12. Product walkthrough — release candidate

44 assertions against the RC on schema `0029`. **44 / 44 passed.**

Patient: register, read profiles, **create a second profile (the P12 404, now
201)**, create a medication with an inline schedule and stock, `/v1/today`, take,
undo, replay the same `clientEventId`, skip, medications list, dose history,
weekly report, adherence, low stock, `/v1/me`, sessions.

Caregiver: invite, accept, read permitted data, **be refused (403) for data the
permission set does not cover** — the P12 decision, an explicit refusal rather
than a silently empty screen — revoke, and be refused after revocation.

Account: password change with a wrong current password refused (401), refresh
rotation, refresh replay refused (409 `refresh_superseded`), logout, the
logged-out token refused, re-login.

Emergency: QR enable, scan returns the limited card, disable, and the disabled
token no longer scans.

Not claimed: real push delivery, real OTP delivery, real OCR, real object storage.
All four ran as recording mocks, and `/health/ready` names them in
`mockedIntegrations`.

---

## 13. Safety walkthrough

| Invariant | Result |
|---|---|
| The day's list never offers another day's dose as actionable today | **PASS** — every returned occurrence carried the response's own `localDate` |
| A taken dose cannot become missed | **PASS** — asserted over HTTP, and by `worker-reliability`: "Taken before mark-missed: stays taken", "mark-missed in flight, Taken arrives: one wins, and it is never both" |
| A skipped dose cannot become missed | **PASS** — "Skip and Snooze are protected by the same predicate" |
| Snooze behaves to policy | **PASS** — an already-missed dose is refused with `dose_not_actionable`, not silently snoozed |
| A duplicate worker tick does not duplicate a logical occurrence | **PASS** — "two concurrent materializations cannot both insert the same dose", enforced by a unique index |
| A missed event is generated once | **PASS** — "the database refuses a second missed event for the same dose"; `0025`'s index, verified live |
| Caregiver escalation is deduplicated | **PASS** — "the key is a unique index, so a retry cannot double-notify" |
| Notification privacy is generic by default | **PASS** — `show_medication_in_notifications` defaults to `false`, and 0 existing rows were left NULL by the upgrade |
| The emergency card discloses the minimum | **PASS** — the scan response carried no phone number, email, user id or owner id |
| Replaying a dose confirmation is idempotent | **PASS** |

---

## 14. Adversarial authorization

| Attack | Result |
|---|---|
| Patient A → Patient B's schedule | **refused** (404) |
| Patient A → Patient B's medications | **refused** (404) |
| Patient A writes a medication into B's profile | **refused** |
| Caregiver holding `view_schedule` but not `view_reports` | **403**, not an empty page |
| Revoked caregiver | **refused** |
| Disabled account | `auth-session.test.ts`, `endpoint-authorization.test.ts` — **PASS** |
| Refresh replay | **refused** — 409 `refresh_superseded` on the RC; the baseline revokes the session |
| Concurrent refresh | `auth-session.test.ts` "one winner" — **PASS** |
| Registration enumeration | `identity-enumeration.test.ts` — **PASS** (registration remains a deliberate, documented exception: the account genuinely cannot be created twice) |
| `X-Forwarded-For` spoofing | `identity-enumeration.test.ts` + `TRUST_PROXY_HOPS` — **PASS** |
| Shared limiter across two instances | `shared-rate-limit.test.ts` — **PASS**; and measured live: 401 ×9 then 429 with `retryAfterSeconds` |
| Concurrent OTP consume | `otp-security.test.ts` — **PASS** |
| Unauthenticated / forged bearer | **401** |

---

## 15. Failure injection

Live, against the running release candidate:

| Injection | `/health` | `/health/ready` | Requests | Recovery |
|---|---|---|---|---|
| Database refuses the API role | **200** | **503 `degraded`**, `database.ok: false`, reason named | fail closed, no data served | **automatic** — 200 `ready` again without a restart |

By permanent test:

| Scenario | Test | Result |
|---|---|---|
| Worker survives the database going away | "a failed tick is caught and does not stop the loop" | PASS |
| A connection dying releases the job lock | "no stale lock survives a crash" | PASS |
| Push provider **definite** failure | "a permanent failure is recorded and not retried forever" | PASS |
| Push provider **ambiguous** failure | "an unknown provider outcome is retried, a known failure is not"; "window 3 — dies during the provider call: outcome unknown, and the lease still recovers" | PASS |
| Worker restart, 7 crash windows | windows 1–7, each asserted separately | PASS |
| Housekeeping partial failure | "a failed step: later steps run, `job_runs` records the failure, the next run retries it" | PASS |
| SecureStore unavailable | "does not silently mint a replacement when the store is unreadable" | PASS |
| Encrypted-cache key unavailable | "raises when the key is gone but the ciphertext is not" | PASS |

The RC worker, run against `0029`: **zero** `permission denied` lines, jobs
complete, missed marking and stock alerts run, and failures are logged as
`errorCode: no_active_device` — a code, never raw provider text, which is the P13
sanitizer holding in a real run.

---

## 16. Release traceability

`GET /version` on the release candidate returns exactly four keys and nothing
else:

```json
{"service":"dawaee-api","commit":"unknown","version":"unknown","builtAt":"unknown"}
```

`unknown` is correct here: the process was started directly, without the build
arguments the Dockerfile freezes into the image. The values are read from
build-time `ARG`s, never from the running environment, so the endpoint describes
the artefact.

**The release candidate commit is NOT identifiable from a running API on Render**,
because the Render build does not pass `GIT_COMMIT`. `render.yaml` has no
`buildArgs`, so `/version` will report `unknown` in production. That is honest —
better than a stale or invented SHA — but it means traceability comes from the
Render deploy record, not from the service. **Adding `GIT_COMMIT` to the
blueprint's build arguments is a one-line change that would close it.**

---

## 17. Production configuration checklist

No value is read or printed. Presence and validation only.

| Variable | API | Worker | In repo config | Operator must set | Validation at boot |
|---|---|---|---|---|---|
| `DATABASE_URL` | ● | ● | declared `sync: false` | **yes** | required, non-empty; connection proven by `/health/ready` |
| `DATABASE_SSL` | ● | ● | literal `"true"` | no | enum `true`/`false`/`no-verify`; **must be `true` in production or the service refuses to boot** |
| `DATABASE_CA_CERT` | ● | ● | declared `sync: false` | only if the endpoint does not chain to a public root | optional; `DATABASE_CA_CERT_FILE` is the alternative |
| `DATABASE_ROLE` | ● | ● | declared `sync: false` | **yes** — carries the Supabase pooler tenant suffix | required for the app to connect as `dawaee_app` |
| `DATABASE_ROLE_PASSWORD` | ● | ● | declared `sync: false` | **yes** | must match what `migrate.sh` wrote |
| `DAWAEE_APP_PASSWORD` | — | ● | declared `sync: false` | **yes** | consumed by `migrate.sh`'s role grants |
| `DAWAEE_WORKER_PASSWORD` | ● | ● | declared `sync: false` | **yes** | same |
| `DATABASE_POOL_MAX` | ● | ● | not declared | no | 1–100, default 10 |
| `JWT_SECRET` | ● | ● | declared `sync: false` | **yes** | ≥ 32 chars always; **≥ 48 in production or boot fails** |
| `JWT_ISSUER` | ● | ● | not declared | no | default `dawaee` |
| `IP_HASH_SALT` | ● | ● | declared `sync: false` | **yes** | ≥ 8 chars; **the dev default is refused in production** |
| `OTP_DEBUG_ECHO` | ● | — | literal `""` | no | **must be false in production or boot fails** |
| `TRUST_PROXY_HOPS` | ● | — | **not declared** | **yes — see below** | 0–10, **defaults to 1** |
| `CORS_ORIGINS` | ● | — | declared `sync: false` | **yes** | empty means same-origin only |
| `PUBLIC_APP_URL` | ● | ● | declared `sync: false` | **yes** | used in invitation links |
| `PUSH_PROVIDER` | ● | ● | declared `sync: false` | **yes, to send anything** | `mock` \| `expo`; **currently `mock` in production** |
| `EXPO_ACCESS_TOKEN` | ● | — | declared `sync: false` | with `PUSH_PROVIDER=expo` | optional |
| `OCR_PROVIDER` | ● | ● | declared `sync: false` | for OCR | `mock` \| `google_vision` \| `azure_document_intelligence` |
| `GOOGLE_VISION_API_KEY` / `AZURE_DI_ENDPOINT` / `AZURE_DI_KEY` | ● | — | declared `sync: false` | with the matching provider | optional |
| `STORAGE_PROVIDER` | ● | ● | declared `sync: false` | **yes** | `local` \| `s3` \| `r2`; **`local` is refused in production** |
| `STORAGE_BUCKET` / `_ENDPOINT` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | ● | ● | declared `sync: false` | with `s3`/`r2` | optional in schema |
| `UPLOAD_MAX_BYTES` | ● | — | not declared | no | default 15 MiB |
| `WORKER_TICK_SECONDS` | — | ● | literal `"60"` | no | — |
| `APP` | ● | ● | literal | no | selects the entrypoint |

**`TRUST_PROXY_HOPS` is not declared in `render.yaml` at all** and defaults to 1.
It decides which address the rate limiter and the IP hash treat as the client. On
Render the correct value depends on the proxy chain in front of the service, and
P17 §19 could not measure that chain because production has no external traffic
and the audit environment cannot reach `*.onrender.com`. Getting it wrong makes
every per-IP control either trivially spoofable or applied to Render's own proxy.
**Determine it before the service takes real traffic.**

---

## 18. Blockers, separated

### SECURITY RELEASE BLOCKERS

1. **Definer policies are missing on 20 of the 26 FORCE-RLS tables.** Registration —
   and by extension the product — is broken on any database whose owner lacks
   `BYPASSRLS`. Confirmed by measurement. Full detail at the top of this document.
2. **`main` has no branch protection and no required status checks.**
   `protected=false`, enforcement off. Independently confirmed by the operator.
3. **The CI workflow has never executed.** Every P16 gate is configuration.

### INFRASTRUCTURE RELEASE BLOCKERS

4. **Auto-deploy is on, for six services, on `main`, triggered by commit** — and
   the API has no `preDeployCommand` while the worker does. A push starts both
   deploys at once and the API can boot before the schema it needs exists.
   Measured consequence: 100 % of authentication requests return 500, while
   `/health` and `/health/ready` both report healthy.
5. **Readiness does not check schema compatibility.** `/health/ready` runs
   `SELECT 1`. A cheap assertion on the `app.*` functions the build requires would
   convert a silent 500-storm into an honest 503.
6. **The production image has never been built.** Registry blocked here; the
   `docker` CI job has never run.
7. **`migrate.sh` may fail at the role-grant step** if `dawaee_app` and
   `dawaee_worker` were created in production by a role other than the one in
   `DATABASE_URL` — PostgreSQL 16+ requires ADMIN on a role to change its
   password. It would fail inside the worker's pre-deploy, failing the deploy.
8. **`GIT_COMMIT` is not passed as a build argument**, so `/version` reports
   `unknown` on Render and the running service cannot name its own commit.

### PRODUCT FEATURE BLOCKERS

9. **Push is a mock in production.** No reminder reaches anyone. Turning it on is
   a separate change with its own verification.
10. **OTP delivery is not implemented.** `POST /v1/auth/otp/request` returns
    **503 `provider_unavailable`** by design, at both the baseline and the RC.
    Password sign-in is the only route in.
11. **Live storage and OCR are unverified.** Both run as mocks; `STORAGE_PROVIDER`
    must be `s3` or `r2` in production or the service refuses to boot, so this is
    a boot-blocking configuration item as well as a feature gap.
12. **App Lock, SecureStore and background notification delivery are unverified on
    real hardware.** Simulated coverage is thorough; a device has never run it.
13. **`buildNumber` and `versionCode` are both still `1`.**

### POLICY / LEGAL FOLLOW-UP

14. **Retention periods have no legal or product approval.** Technical enforcement
    exists; the approval does not. POLICY MISSING since P13.
15. **Registration enumeration is a PROPOSED ACCEPTED RISK.** Registration must
    reveal that an identifier is taken; sign-in stays uniform. Needs an explicit
    decision.
16. **The emergency card's `patientName` disclosure is a deliberate trade-off**
    between a paramedic's need and the patient's privacy. Needs an explicit
    decision.
17. **Saudi PDPL applicability has not been formally assessed.** Nothing in this
    document is a compliance claim.

---

## 19. NOT RUN

| Item | Why |
|---|---|
| Production Docker image build | container registries blocked (403); no Docker daemon |
| Base image digest pin | cannot resolve a digest without registry access |
| GitHub Actions SHA pinning | cannot resolve tags to SHAs without registry access |
| GitHub Actions execution | never triggered; `main` untouched by design |
| `expo-doctor` online checks (4 of 18) | Expo API not in the egress allowlist |
| EAS native signed build | no credentials, no signing material, no network path |
| Real-device mobile tests | no device |
| Any probe of the deployed service | `*.onrender.com` blocked |
| Proxy / TLS topology (`TRUST_PROXY_HOPS`) | no external traffic exists to observe |
| Render log retention | not exposed to this integration |
| Historical retention cleanup | never executed |

---

## Result

The repository builds, typechecks, lints, migrates cleanly from zero and from
production's exact schema, passes 1013 tests on both PostgreSQL 16 and 17,
preserves every seeded row through the upgrade, fails closed when run against the
wrong schema, and closes two defects that are live in production right now — a
profile-creation 404 that blocks every user, and an account-takeover hole in the
password change that this rehearsal exploited end to end.

It also cannot start on a database configured the way its own migration `0008`
says the deployment target is configured, and nothing in 1013 tests noticed,
because every one of them runs against a superuser-owned database.

**P18 FAIL — RELEASE CANDIDATE NOT READY.**

## Recommendation for P19

1. Generate the definer policies from `pg_class` rather than a hand-kept array, in
   a new migration `0030`. Every `FORCE ROW LEVEL SECURITY` table in `public`, so
   a table added later cannot reintroduce the gap.
2. Make CI start the API against the non-superuser-owned database it already
   creates, and run registration plus one authenticated read against it. This is
   the test whose absence let the blocker through.
3. Add the `app.*` functions the build requires to `/health/ready`, so a
   schema-behind API reports 503 instead of serving 500s under a green health
   check.
4. Pass `GIT_COMMIT` as a build argument in `render.yaml`.
5. Decide `TRUST_PROXY_HOPS` for Render, and declare it.
6. Then re-run P18 in full. Not a spot check — the same rehearsal, because points
   1 and 3 change the schema and the readiness contract.
