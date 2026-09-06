# P19 — final adversarial review

Executed 2026-09-06. **Nothing was pushed, deployed, migrated against
production, or changed on Render or GitHub.** No branch protection was touched,
no service or database deleted, no provider enabled.

| | |
|---|---|
| **Final RC commit** | **`bfb8e227e1f79ae6a1f894be70d81f27c2e74176`** |
| Supersedes | `c77667b` (the RC P18 passed) — **P18 evidence for `GET /v1/uploads/url` is superseded** |
| Production / `main` | `db7061f1ae8fc52a02d68aea76da8a46ff382b04` — unchanged |
| Working tree | clean, `git diff --check` clean |
| Migrations `0001`–`0019` | byte-identical to the production baseline |

---

## Executive summary

P19 set out to falsify P1–P18 rather than confirm it. It found **one HIGH
defect that every previous phase missed**, one LOW, and one hardening item.
Everything else held under attack.

**P19-1 (HIGH).** `GET /v1/uploads/url` had no application-layer authorization
at all. A caregiver holding only `view_adherence` — refused 403 on
`/v1/medications` and `/v1/today` in the same session — obtained a working read
URL for the patient's **prescription image**. Reproduced, fixed, eight
regression tests, negative control confirmed.

The route relied on row-level security, and the comment where the check should
have been said so:

> `// RLS on stored_objects means an object belonging to another patient simply is not visible here.`

True, and not the question. The policy is
`owner OR app.can_read_profile(...)`, and `app.can_read_profile` is
`owns_profile OR caregives_profile` — **any** active caregiver, with no
reference to the permission set. It is the P12-14 class of defect on the one
route P12 did not cover, and it survived P12, P13, P16, P18 and P18-R because
every test of that route used the profile owner.

Beyond that, the release candidate held: 44 database-role escalation attempts
refused, 238 injection probes with no leak and no schema change, the OTP
verifier irreversible against 5 million offline hash evaluations, the emergency
QR behaving as a bearer credential should, and the three-state deployment matrix
correct.

**The release candidate is technically ready. The release is not.** Three
deployment gates remain unsatisfied and P19 has no authority to close them.

---

## Baseline → final RC

| | |
|---|---|
| Baseline | `db7061f` — what production runs today |
| Final RC | `bfb8e22` |
| Commits | 33 |
| Migrations | `0020` … `0030` — 11 pending |
| Test suite | 909 → **1069** |
| PostgreSQL | 16.13 **and** 17.10, both green |

---

## §1 Release candidate integrity

- `git status` clean; `git diff --check` clean on working tree and index.
- `0001`–`0019` md5-identical to the deployed baseline — production's ledger
  cannot refuse the release.
- No negative-control mutation is committed. Every P18/P18-R/P19 mutation was
  either transactional and rolled back, or explicitly undone and re-verified.
- Dangerous-pattern sweep (`TODO SECURITY`, `TEMP`, `DEBUG`, `BYPASS`,
  `NO_VERIFY`, unsafe fallback, test-only override): **28 hits, all classified,
  none a defect.** They are config guards (`DATABASE_SSL=no-verify` is *refused*
  in production; `OTP_DEBUG_ECHO` is *refused* in production), the deliberate
  `style-src 'unsafe-inline'` CSP for React Native Web, and prose in comments
  describing the defects that were fixed.

Two files contain literal control bytes: `operational-error-privacy.test.ts`
(ANSI escapes, NUL) and `upload-emergency-security.test.ts` (NUL). Both are
**deliberate attack fixtures** in tests that assert those bytes are stripped.
They work, and they make the files "binary" to `grep`/`diff`. Informational.

---

## Findings

### P19-1 — HIGH — a prescription image was readable by any caregiver

**Reproduction, before the fix:**

```
patient uploads a prescription image -> 200 prescription_image/2026-09-06/…/….jpg
caregiver accepted with permissions ["view_adherence"] -> 200
  GET /v1/medications    -> 403
  GET /v1/today          -> 403
  GET /v1/uploads/url    -> 200
  {"url":"/v1/uploads/local/prescription_image%2F…?expires=…&sig=…","expiresInSeconds":300}
```

The signed URL then serves the bytes with no further authorization, so this is a
complete disclosure of the most sensitive object the product stores, not a hint
that one exists.

**After the fix:** `403 {"code":"forbidden","message":"Missing permission: view_medications"}`

**The fix.** `medication_image` and `prescription_image` require
`view_medications` on the object's profile — the same permission the medication
list requires, and P12's decision that an explicit 403 beats a silently empty
screen. Two deliberate exemptions, both pinned by test:

- **`avatar` stays readable.** A profile picture is not medication data and
  every caregiver is meant to see whose profile they are looking at.
- **The uploader keeps access to what they uploaded.** A caregiver may hold
  `add_medication` without `view_medications`; removing their own upload
  mid-flow would break the screen that just created it.

An unrelated account still gets **404**, byte-identical to the response for a
key that does not exist — no existence oracle.

**Regression:** 8 tests in `endpoint-authorization.test.ts` (`P19-1`), including
a positive control (adding `view_medications` makes both images readable) and a
revocation check. **Negative control:** with the check disabled, exactly the two
disclosure assertions fail and the other six still pass.

**Why five phases missed it.** Every existing test of `/v1/uploads/url` used the
profile owner, for whom RLS and the permission model agree. P12's audit worked
from the routes that *called* `requireProfileAccess` and asked whether they asked
for enough; a route that called it not at all was outside that frame.

### P19-2 — LOW — a caregiver invitation token in plaintext AsyncStorage

`dawaee.pendingInvitationToken` holds an invitation bearer token in the clear
between opening a deep link and completing sign-in. Not PHI. Single-use,
72-hour default expiry, `allowBackup=false`, and redemption still requires an
authenticated account — so it is a LOW finding, not a blocker. But it is a
credential in the weakest store on a device where the project already decided
credentials belong in the keychain.

**Recorded, not fixed** — moving it is a behaviour change to the deep-link flow,
and P19 is a review. **A new structural test pins the complete inventory of
plaintext storage keys**, with the reason for each, so the next addition is a
failing build rather than a silent one. Verified to fire: introducing
`dawaee.newPlaintextPhiKey` fails the test naming the file.

### P19-3 — INFORMATIONAL, hardened — the last SQL interpolation

`runStep` built `SAVEPOINT ${step}` by interpolation, because a savepoint name
cannot be a bind parameter. It is the only interpolation left anywhere in the
codebase. Every caller passes a string literal, so nothing user-controlled
reaches it — a property of today, not of the code. Now guarded by
`/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/` plus three tests: hostile names throw, all nine
real step names still run, and the call sites are asserted to be literals.

---

## §2 Account takeover chain — refused

| Attack | Result |
|---|---|
| Sign-in enumeration | **Indistinguishable** — unknown identifier and wrong password both 401, identical `invalid_credentials` body (differing only by `requestId`) |
| Password spray, 14 attempts from 14 addresses | Rate-limited; rotating the address buys nothing |
| Forged `X-Forwarded-For` chain + `X-Real-IP` | Refused; budget not reset |
| IPv6 host rotation inside one `/64` | 429 — one bucket per prefix |
| Concurrent refresh | At most one winner; the presented token dead afterwards |
| Replay after the supersede grace | Refused |
| Password change with a stolen access token, no password | Refused; victim's password unchanged |
| Real password change | Other sessions revoked; old password no longer signs in |
| Disabled account: existing access token / refresh / sign-in | All three refused |
| **Re-enable** | Old refresh token **stays dead**; push tokens **stay inactive** |

**No old credential resurrects.**

## §3 Patient A → Patient B — refused

17 read surfaces, 10 write surfaces, dose-level actions on foreign ids, mixed
parent/child ownership, mass assignment (`id`, `createdBy`, `owner_user_id`,
`patient_profile_id` in the body), and a cross-tenant idempotency collision.

**Zero unauthorized reads, zero unauthorized writes.** Mass assignment could not
reparent a medication. A `clientEventId` shared across tenants confirmed each
tenant's own dose exactly once and left the other untouched — one event each.

Two initial results proved to be my own probe defects and were re-tested with
request shapes the routes accept: refill (`quantityAdded`, not `quantity`) and
uploads (`objectKey`, `purpose: medication_image`). Both refused on re-test, with
foreign and nonexistent ids indistinguishable (404/404), and A's stock unchanged.

## §4 Caregiver escalation — refused, and one breach (P19-1)

A caregiver holding only `view_adherence` was refused on 13 read surfaces and 6
write surfaces, could not widen its own permissions (the relationship row still
held exactly `['view_adherence']`), could only produce a `revoked` row when
removing itself, and was refused after revocation.

**The intentionally permitted path holds:** aggregate adherence works without
`view_medications` (200, `summary.scheduled > 0`) and **discloses no medication
identity** — no name, no `medicationName`, no `brandName`, no `genericName`.

`GET /v1/uploads/url` was the exception. See P19-1.

## §5 Database role escalation — refused

24 attempts as `dawaee_app` and `dawaee_worker`, plus the definer-plane probes:

`SET ROLE` to the owner or to `postgres`; `CREATE FUNCTION … SECURITY DEFINER`;
`CREATE POLICY`; `DISABLE`/`NO FORCE ROW LEVEL SECURITY`; `ALTER TABLE … OWNER
TO`; dropping a definer policy; `ALTER ROLE … BYPASSRLS`; reading a password
hash; creating a table in `public`; `set_config('is_superuser')`;
`set_config('role', …)`; creating a schema to shadow from — **all refused**.

- **Every `app.*` SECURITY DEFINER function pins its `search_path`** — measured
  from `pg_proc.proconfig`: 0 unpinned of 25.
- A hostile client `search_path` did not break the definer plane.
- Hostile inputs into the definer functions (quote-breaking scope names,
  stacked-statement permission strings) left the schema intact.
- `dawaee_app` cannot execute `cleanup_expired_sessions`, `purge_rate_buckets`
  or `ensure_definer_policies`.

**The core claim of 0030 holds under attack:** with no `app.user_id`,
`dawaee_app` sees **zero** rows in `patient_profiles` while the owner sees many.
The exemption that makes `register_with_password` work is not reachable from the
application role.

## §6 SQL injection into the RLS context — none found

14 payload families — quote-breaking, `SET app.user_id`, `set_config`,
`SET ROLE`, `UNION SELECT`, stacked `DROP TABLE`, `pg_sleep`, encoded and
escaped variants, blind boolean, a sub-select for a password hash — across:

- **12 URL surfaces** (168 probes): profileId, date range from/to, limit,
  offset, status filter, medication id path, dose id path, object key, emergency
  scan token, adherence range, report export.
- **5 body surfaces** (70 probes): note text and tags array, medication name,
  schedule rule JSON, caregiver permissions array, login identifier.

**0 leaks. 0 timing oracles. 0 500s. 0 schema changes.** `app.user_id` remained
empty on a fresh pooled connection; `p19_evil` policy and function count 0;
`users` and `dose_events` intact.

Static confirmation: the codebase has **one** SQL interpolation
(`SAVEPOINT ${step}`, now guarded) and **one** constant-fragment interpolation
(`${DOSE_LIST_SELECT}`). All parameter binding elsewhere.

## §7 OTP

The verifier is `HMAC-SHA256(HKDF(JWT_SECRET, "dawaee:otp-verifier:v1"), phone:code)`.

Attacked as somebody holding a database dump would, **without** the server
secret: 10⁶ codes × 5 constructions (`sha256(code)`, `sha256(phone:code)`,
`sha1`, `md5`, `hmac(phone, code)`) = 5 million evaluations in 6.2 s → **no
match**. With the secret the same code verifies, so the check is not vacuous, and
the verifier is bound to the phone (the same code under another number produces a
different value).

Single live challenge per phone enforced by a unique index, not by timing.
Attempt accounting, expiry and consumption columns all present.

> **OTP DELIVERY IS NOT IMPLEMENTED.** `POST /v1/auth/otp/request` returns a
> deliberate **503 `provider_unavailable`**. OTP login is **not
> production-functional**. Password sign-in is the only route in.

An earlier probe appeared to "recover" a code. It recovered its own `sha256`
insert, not the API's construction — recorded because a red-team report that
hides its own false positives is not a red-team report.

## §8–9 Mobile token theft and local PHI

Covered by 160 permanent tests executed in both suite runs, against mocked
native modules — **not on a device**. Legacy adoption, SecureStore-wins,
interrupted-migration resume, failed-cleanup convergence, two-account isolation,
offline-queue integrity, low-stock snooze migration, and fail-closed behaviour
when the keychain is unreadable.

P19 added the **inventory** guard that was missing: seven plaintext AsyncStorage
keys, each with a written reason. One of them (P19-2) is a credential.

Notification payload: `data` carries `doseId`, `medicationId` and `kind` —
opaque identifiers, no names. Title, body and the spoken subtitle all follow the
same `showMedication` flag, whose column default is **`false`**, and the upgrade
left **0 NULL rows**. Generic remains the default.

## §10 Medication safety — held

| Invariant | Result |
|---|---|
| The day's list contains only the day's own doses | **PASS** — 0 foreign-dated entries |
| The prefetch window does not smuggle another day in as actionable | **PASS** — the one today-dated prefetch entry is the *same dose id* already in `today` |
| Confirming the last dose does not pull tomorrow into today | **PASS** |
| A taken dose stays taken | **PASS** |
| Replaying a confirmation does not multiply adherence events | **PASS** — 1 event, second call 409 |
| No dose carries two missed events | **PASS** |
| No confirmed dose was later marked missed | **PASS** |

Plus the permanent worker-reliability suite: taken/skip/snooze vs mark-missed in
both orders, escalation dedupe by unique index, timezone and DST boundaries.

## §11 Worker crash — at-least-once, stated honestly

The claim is **at-least-once with a bounded, documented duplicate window**, and
`docs/PUSH-DELIVERY-SEMANTICS.md` says so in its second sentence. Nothing in the
codebase claims exactly-once for delivery.

Seven crash windows are asserted individually. **Window 4 — crash after a
successful send, before finalising — re-sends. That duplicate remains possible
and is accepted**, because the alternative is dropping a medication reminder.
Every finalising write is guarded by `WHERE id = $1 AND lease_token = $2`, so a
stale worker whose lease was reassigned writes nothing.

**P19 does not convert this to exactly-once.**

## §12 Housekeeping — isolation holds

Failure injected into the **first** step by revoking its `EXECUTE`:

```
the broken step really is broken   -> 42501
a LATER retention class still runs -> returned 0
and it recovers once the grant is back -> restored
```

No recurrence of P8-2 (one failure silencing every later class) or P10-3.

## §13 Emergency QR — behaves as a bearer credential

| Property | Result |
|---|---|
| Entropy | 32-char token, ≥192 bits |
| Storage | `qr_token_hash` — a hash, never the token |
| Mutation (last char, case, append, truncate) | 404 on all four |
| Rotation | Previous token 404, new one 200 |
| Disable | 404 |
| Internal identifiers in the card | **none** — `patientName, bloodType, allergies, conditionsNote, emergencyContacts, medications…` |
| Phone number or email in the card | **none** |
| `cache-control` | `no-store, no-cache, must-revalidate, private` |
| `referrer-policy` | `no-referrer` |
| URL redaction in logs | asserted by `audit-privacy.test.ts` |

**Documented policies, asserted and deliberately unchanged:**

- `patientName` is **always shown** — a paramedic needs to know whose card this
  is. PROPOSED ACCEPTED PRIVACY TRADEOFF.
- A **disabled account's QR still scans** (verified: 200). Disabling is an
  account action; a person's allergy list should not vanish from an emergency
  card because of it. PROPOSED SAFETY POLICY.

## §14 Upload / OCR

| Attack | Result |
|---|---|
| BOLA: B reads A's object | **404** |
| Foreign vs nonexistent object key | **404 / 404** — indistinguishable |
| Path traversal ×5 (`../../etc/passwd`, Windows separators, space, `/../`, absolute) | **404 on all** |
| Forged signature on the read URL | **403** |
| Expired signature | **403** |
| Signature swapped onto another object key | **403** |
| OCR over a foreign object | Refused |
| OCR without recorded consent | 428 `consent_required` |
| Caregiver without `add_medication` uploading into the profile | **403** naming the permission |
| Caregiver without `view_medications` reading an image | **403** — *after the P19-1 fix* |

Live providers remain **NOT RUN / MOCKED**. Nothing here is a claim about S3,
R2, Google Vision or Azure Document Intelligence.

## §15 Logging and secret exfiltration

Secrets and PHI driven through every sink — database error, provider error,
request URL, job error, note text, medication name, object key, login password —
then searched in stdout, `job_runs`, `notification_deliveries` and `audit_logs`:

| Sink | Result |
|---|---|
| JWT secret in stdout | none |
| Password in stdout | none |
| Database password in stdout | none |
| Connection string in stdout | none |
| Medication / note PHI in stdout | none |
| Full bearer token in stdout | none |
| `job_runs.error_message` | no PHI, no secret |
| `notification_deliveries.error_code` | codes, not provider prose |
| `notification_deliveries.error_detail` | no PHI, no secret |
| `notification_deliveries.body` / `title` | no medication name |

**One initially-flagged item resolved as designed, not a defect.** `audit_logs`
*does* store the medication name for `medication.created` — and P13 decided that
deliberately (`audit-privacy.test.ts`: *"does record the medication name and the
notes that changed — and that is the point"*). The policy `audit_read` restricts
SELECT to `app.owns_profile(...)` — **the owner only, no caregivers**. Verified
adversarially: a caregiver holding `view_reports` **and** `view_medications` was
refused the export (403) and received no audit rows.

No secret is committed to the repository (`gitleaks` job configured; `.npmrc`
gitignored since P14).

## §16 Deployment attack — the matrix holds, and its failure modes refuse

| State | Result |
|---|---|
| OLD `db7061f` + schema `0030` | **41/44** — the three failures are the known baseline defects the RC fixes (P12 profile-creation 404; wrong-current-password accepted; the resulting takeover). Nothing new broken. |
| RC + schema `0019` | **STARTUP REFUSED** — exit 1, no port bound, all 11 missing migrations named, no secret in the message |
| RC + schema `0030` | **ready**, `/health/ready` 200 with `schema: 0030_definer_privilege_model.sql` |

Failure modes, each refusing **before** unsafe serving:

- **Migration owner without role-admin** → preflight refuses, **`tables=0`**.
- **Missing definer preflight** → `0030` refuses with a hint naming the file.
- **Partial migration state** — the differential that matters:

  | | populated `0019` → `0030`, as the migration owner |
  |---|---|
  | hand-run `psql` loop, no preflight | **ABORTS at `0025`** — `could not create unique index … Duplicate keys exist`, with `0020`–`0024` committed |
  | `scripts/migrate.sh` | **exit 0**, ledger 30, 3 duplicate missed events collapsed to 1 |

- **Checksum divergence** → refused twice, independently: `migrate.sh`
  (*"immutable once shipped"*) and the API startup gate (*"checksum differs:
  0008_security_rls.sql"*).
- **`0030` invariant violation** → a `TO PUBLIC` policy aborts the migration by
  name.

## §17 Dependency and build drift — none

`package.json` and both lockfiles unchanged. Typecheck, lint (root and mobile),
API build, worker build, mobile typecheck: all clean. Dependency gate:

```
root   : 0 advisory roots
mobile : 6 roots (1 runtime-reachable, 5 build-toolchain), 33 npm entries
         RUNTIME moderate  accepted  decode-uri-component
         build   high      accepted  @xmldom/xmldom, image-size, postcss
         build   critical  accepted  tar
         build   moderate  accepted  uuid
Dependency gate passed.
```

`decode-uri-component` carried unchanged as a PROPOSED ACCEPTED RISK.

## §18 CI and release control review

Least privilege: top-level `permissions: contents: read` on all three workflows;
per-job elevation only for `security-events: write` on the SARIF upload, with the
reason written next to it. Present and configured: PG16+17 matrix, RLS probe,
non-superuser migration job, **managed-Postgres smoke**, full suite, mobile
typecheck, Docker build + container checks, Trivy (filesystem and image), CodeQL,
gitleaks, dependency gate, scheduled audit.

GitHub Actions are **not SHA-pinned** — BLOCKED, resolving tags to SHAs needs
registry access this environment does not have.

> **GitHub Actions execution remains NOT RUN.** No workflow run exists for this
> RC. Everything above is configuration.

---

## §19 Production reality check

### A. Release candidate quality — `bfb8e22`

Builds, typechecks, lints, migrates from zero and from production's exact schema
on a realistically-owned database, passes **1069 tests on PostgreSQL 16.13 and
17.10**, refuses to boot against a schema it does not fit, and survived this
review with one HIGH finding, now fixed with tests and a negative control.

### B. Current production quality — `db7061f`

**Production is not fixed. None of this is deployed.** Measured on the deployed
build during P18 and P19, and still true:

- `POST /v1/profiles` returns **404 for every user** — profile creation is
  broken.
- `POST /v1/auth/password` accepts a **wrong current password**; the attacker's
  new password then signs in. **Account takeover, live.**
- `GET /v1/uploads/url` discloses prescription images to any caregiver
  (P19-1 — present in `db7061f`, fixed only in the RC).
- Push runs as a **mock**: no reminder reaches any patient.
- The worker logs `permission denied for table auth_sessions` **every hour**;
  housekeeping has never run.
- Registration fails outright if the database owner cannot bypass RLS
  (P18-R) — and the P18-R preflight repairs it before a single migration.

The one mitigating fact: production has **no external traffic**. Render's own
prober is the only client.

---

## Final security table

| ID | Sev | Finding | Original status | Final status | Evidence |
|---|---|---|---|---|---|
| P19-1 | HIGH | `GET /v1/uploads/url` had no permission check; a `view_adherence` caregiver read a prescription image | OPEN (found in P19) | **FIXED + 8 tests + negative control** | 200→403 reproduction; `endpoint-authorization.test.ts` |
| P18R-1 | CRITICAL | Definer policies missing on 20 of 26 FORCE-RLS tables; registration 404 on a managed Postgres | OPEN (P18) | **FIXED** (`0030` + sweep + 33 tests) | 404→200 on the deployed build after the sweep |
| P18R-2 | CRITICAL | `0025` dedup DELETE silently matched nothing; upgrade aborted with 0020–0024 committed | OPEN (P18-R) | **FIXED** (preflight) | differential: abort vs exit 0 |
| P18R-3 | HIGH | `migrate.sh` granted the worker default privileges on every future table | OPEN (P18-R) | **FIXED** | `pg_default_acl` now names only `dawaee_app` |
| P18R-4 | MEDIUM | `0021` created a `TO PUBLIC` policy | OPEN (P18-R) | **FIXED** | caught by `0030` assertion 3b |
| P18-1 | HIGH | New code boots healthy against an old schema; 100% of auth 500s | OPEN (P18) | **FIXED** (startup gate) | exit 1, no port bound |
| P18-2 | MEDIUM | `migrate.sh` discovers role-admin failure after committing migrations | OPEN (P18) | **FIXED** (preflight) | `tables=0` on refusal |
| P18-3 | LOW | `/version` could not name the running commit on Render | OPEN (P18) | **FIXED** | `RENDER_GIT_COMMIT` precedence, verified live |
| P12-1 | HIGH | `POST /v1/profiles` 404 for every user | OPEN (P12) | **FIXED** | live: baseline 404, RC 201 |
| P9-1 | CRITICAL | Password change accepted a wrong current password → takeover | OPEN (P9) | **FIXED** | live: baseline 200 + attacker signs in; RC 401 |
| P12-14 | HIGH | Caregiver routes read more than they asked permission for | OPEN (P12) | **FIXED** | 403 naming the permission |
| P8-2 | HIGH | Housekeeping never ran; one failure silenced every later class | OPEN (P8) | **FIXED** | live: later class runs, recovers |
| P13-1 | MEDIUM | `err.detail` PHI in logs; raw errors in `job_runs` | OPEN (P13) | **FIXED** | live injection: no PHI in any sink |
| P11-1 | MEDIUM | Emergency token written to logs in plaintext | OPEN (P11) | **FIXED** | URL redaction asserted |
| P19-2 | LOW | Invitation bearer token in plaintext AsyncStorage | OPEN (P19) | **RECORDED + drift guard** | inventory test, fires on a new key |
| P19-3 | INFO | `SAVEPOINT ${step}` interpolation | OPEN (P19) | **HARDENED + 3 tests** | hostile names throw |
| — | MEDIUM | `decode-uri-component` DoS (mobile runtime) | OPEN (P14) | **PROPOSED ACCEPTED RISK** | dependency gate, dated exception |

---

## Phase matrix

| Phase | Subject | Final status |
|---|---|---|
| P1–P3 | Mobile credentials, encrypted cache, app lock | PASS (simulated; device NOT RUN) |
| P4 | Database TLS | PASS |
| P5 | Identity enumeration, XFF forgery | PASS |
| P6 | OTP verifier and races | PASS (delivery NOT IMPLEMENTED) |
| P7 | Shared authentication limits | PASS |
| P8 | Worker privilege boundary, RLS matrix, housekeeping | PASS |
| P9 | Sessions, refresh rotation, password auth | PASS |
| P10 | Worker idempotency, leases, patient-local dates | PASS (at-least-once) |
| P11 | Uploads, emergency card | PASS |
| P12 | Endpoint authorization | PASS — **amended by P19-1** |
| P13 | Logging, audit, retention | PASS (policy approval MISSING) |
| P14 | Dependencies | PASS (one accepted risk) |
| P15 | Container | PARTIAL — static only; image NOT RUN |
| P16 | CI security gates | CONFIGURED — execution NOT RUN |
| P17 | Production/Render audit | COMPLETE (read-only) |
| P18 | Release candidate rehearsal | FAIL → remediated |
| P18-R | Remediation | PASS |
| P19 | Adversarial review | **1 HIGH found and fixed** |

---

## Final test evidence

| | PostgreSQL 16.13 | PostgreSQL 17.10 |
|---|---|---|
| Test files | 47 / 47 | 47 / 47 |
| Tests | **1069 passed** | **1069 passed** |
| Failed / skipped | 0 / 0 | 0 / 0 |
| Duration | 220.81 s | 221.82 s |
| Exit | 0 | 0 |

Both against a database owned by a **NOSUPERUSER, NOBYPASSRLS** role. Plus:
typecheck, lint (root and mobile), API and worker builds, mobile typecheck,
`git diff --check`.

Adversarial totals: **84** cross-tenant/takeover/caregiver probes, **44**
database-role and injection assertions, **238** injection payload probes, **19**
upload/OCR probes, **47** OTP/safety/housekeeping/QR/logging assertions.

---

## External blockers — unchanged, none converted by a repository test

| | Status |
|---|---|
| GitHub `main` branch protection | **CONFIRMED MISSING** |
| GitHub Actions execution for the RC | **NOT RUN** |
| Exact production Docker image | **NOT RUN** (registry blocked, no daemon) |
| Live Supabase TLS | **NOT RUN** |
| Live Render `X-Forwarded-For` semantics | **NOT RUN** |
| Real-device App Lock / SecureStore | **NOT RUN** |
| Native signed mobile build | **NOT RUN** |
| Push provider | **MOCK** |
| OTP delivery | **NOT IMPLEMENTED** |
| Storage / OCR | **NOT VERIFIED LIVE** |
| Render log retention | **NOT VERIFIED** |
| Historical retention cleanup | **NOT RUN** |

## Product feature blockers

Push is a mock; OTP delivery is unimplemented (deliberate 503); live storage and
OCR unverified — and `STORAGE_PROVIDER=local` is *refused* at boot in
production, so this is a boot-blocking configuration item as well as a feature
gap; App Lock and SecureStore unverified on hardware; `buildNumber` and
`versionCode` both still `1`.

## Policy / legal items

Retention periods have **no legal or product approval** (technical enforcement
exists; the approval does not). **Saudi PDPL applicability has not been formally
assessed** — nothing in this document is a compliance claim.

## Proposed accepted risks

| | |
|---|---|
| Registration enumeration | Registration must reveal that an identifier is taken; sign-in stays uniform (verified indistinguishable). **PROPOSED ACCEPTED RISK** |
| `decode-uri-component` moderate DoS | Mobile runtime-reachable, no upstream fix. **PROPOSED ACCEPTED RISK / BLOCKED BY UPSTREAM** |
| Emergency `patientName` disclosure | Always shown so a paramedic knows whose card it is. **PROPOSED ACCEPTED PRIVACY TRADEOFF** |
| Disabled-account emergency QR | Still scans; an allergy list should not vanish because an account was disabled. **PROPOSED SAFETY POLICY** |
| Push delivery duplicate window | At-least-once; window 4 can re-send. **ACCEPTED, DOCUMENTED** |
| Caregiver permission UX | `view_schedule` without `view_medications` yields an unusable set; the API now says so with an explicit 403, but the invitation UI still allows the pairing. **PRODUCT FOLLOW-UP** |

---

## Production release plan prerequisites

Before any deploy:

1. **Enable branch protection on `main` with required status checks.** Until
   then, "merged through CI" is a convention, not a control.
2. **Execute CI on the RC** and observe it green on PostgreSQL 16 **and** 17,
   including the managed-Postgres smoke.
3. **Build the production Docker image** and run `scripts/container-checks.sh`
   against it.
4. **Read `SELECT current_user, rolsuper, rolbypassrls`** on the production
   database and record the answer. It decides whether the definer policies are
   load-bearing or merely tidy — either answer is workable; not knowing is not.
5. **Confirm which host `DATABASE_URL` names** before taking the backup.
   `dawaee-db` expires **2026-10-03** regardless.
6. **Run `./scripts/migrate.sh --preflight-only`** and require its five lines.
7. Then `docs/PRODUCTION-RELEASE-RUNBOOK.md` from Step 0, with auto-deploy
   suspended and the API started last.
8. Decide `PUSH_PROVIDER` separately, with its own verification. Turning it on
   sends real messages to real patients.
9. Verify `TRUST_PROXY_HOPS` against a real request before the service takes
   real traffic.

---

## Release decision

The release candidate is technically ready. The release is not, and P19 has no
authority to make it so: branch protection is confirmed missing, no CI run
exists for this RC, and the production image has never been built. Those are
mandatory gates, not conditions to be waved through with a CONDITIONAL GO.

# NO-GO

Not a judgement on the code — on the deployment gates. Close items 1–3 above and
the decision becomes a GO conversation.
