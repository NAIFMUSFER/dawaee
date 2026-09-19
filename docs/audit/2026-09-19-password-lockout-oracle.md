# Password lockout response oracle — 2026-09-19

## Scope and cause

Follow-up to reconciliation **S3**, based on `9e65348f25091e50f1c7149269e785533bd244d5`.
No production deployment, database migration, provider change or account reset.

The baseline finished CI [35474150060](https://github.com/NAIFMUSFER/dawaee/actions/runs/35474150060)
and Security [35474150062](https://github.com/NAIFMUSFER/dawaee/actions/runs/35474150062)
successfully before this source repair was published: **2,862 passing tests /
376 files on each PostgreSQL 16 and 17**, plus 110 RLS attempts with zero
unexplained failures or open findings within that probe. This result is not
transferred to the new source commit; check that commit's own runs.

The locked-account branch verified each candidate against the stored password:
wrong candidates returned `invalid_credentials/401`, correct candidates returned
`account_locked/429`. Denying sessions did not stop an attacker from learning
which candidate was correct. Recording failures during the lock did not close
that response channel.

Read the password service, hashing/decoy implementation, login/session issuance,
non-sliding lock SQL, email recovery, error handler, sign-in UI and linked tests
before changing this branch. Existing password normalization and cost parameters,
advisory locking, session credential recheck, rate budgets and recovery proof
requirements are unchanged.

## Written

- An active lock performs decoy hashing, never verifies a candidate against the
  real password, records every refused attempt and returns the same internal
  `invalid` outcome. The fixed database deadline remains unchanged.
- Unknown, passwordless, disabled, wrong-password and locked refusals share the
  same HTTP status/code/message. Neither password correctness nor lock deadline
  appears in the refusal. Generic retry/recovery guidance is shown to everyone
  in Arabic/English; the wait text uses the existing `LOCK_MINUTES` constant,
  not a user-specific deadline. Login's credential-change race uses that same
  message. The sign-in screen already displays the server message and offers
  the existing Forgot password route; no new automatic recovery is introduced.
- Updated native PostgreSQL regression expectations that intentionally asserted
  the old `locked` response; retained lock activation and non-sliding assertions.
- Added real HTTP/password-service/rate-budget/SQL scenarios to the existing
  PostgreSQL/WASM harness, plus an isolated test proving the real credential
  verifier is never invoked while a lock is active.

## Tested locally

- **62 passing cases / 4 files**: `account-email-sql` (31),
  `review-api-contracts` (21), `password-lockout-service` (2), shared i18n (8).
- **19 passing screen-harness cases / 2 files**: sign-in/sign-up connection
  lifecycle (14) and password recovery (5). New Arabic/English cases verify
  that the refusal message actually reaches the sign-in banner, editing is
  re-enabled, no session or automatic navigation occurs, and the recovery
  button navigates only after an explicit click. These are simulated component
  interactions, not a visible browser or physical-device trial.
- All **94 migrations** applied using a non-superuser/non-bypass-RLS owner in
  PostgreSQL/WASM. Actual login HTTP routes and password hashing compare correct
  and incorrect candidates against unknown, disabled, passwordless and locked
  accounts, with Arabic/English and email/phone identifiers. Responses are
  compared excluding the per-request correlation ID; no token or lock deadline
  is returned. Counter increments and unchanged deadlines are asserted.
- An expired lock permits a correct password, resets the counter and issues a
  session that successfully calls `/v1/me`. Completing a verified email-recovery
  challenge clears the lock, revokes the old session, rejects the old password
  and accepts the replacement. Recovery challenge delivery in these tests is
  simulated locally; this is not a new real-email delivery claim.
- Targeted ESLint, shared-package build, API/worker/mobile TypeScript passed.
  Full exact-head CI remains a separate gate; these local tests do not exercise
  native PostgreSQL multi-connection concurrency or a browser/device.

## Not closed by this repair

- **S4** identifier-budget denial: an attacker can still exhaust the existing
  identifier budget. Do not remove guessing controls to conceal this finding.
- **S6/S8**, privacy/operator facts, native acceptance and physical notification
  delivery remain open as recorded in the reconciliation.
- This establishes equality of the application refusal and removes real-password
  checking while locked. It is not a statistical timing-side-channel assessment
  across databases, replicas, historical hash costs or network conditions.
- Cloud browser tab refresh still times out after 20 seconds in this run. No
  successful UI trial, signed native build or production promotion is claimed.

Keep this source repair separate from deployment and real user acceptance.
