# S6 — proof-first phone linking

Date: 2026-09-20  
Scope: not deployed to production and not submitted to TestFlight.

**Later status:** the candidate is now on the isolated preview; see
[20 September live evidence](2026-09-20-preview-live-verification.md). Email
registration also became proof-first in a subsequent change, so the original
email-enumeration finding at the end of this document is historical, not an
open source defect. See [the email repair](2026-09-20-proof-first-email-registration.md).
Physical Firebase/SMS/phone-login acceptance is still open; email-only preview
accounts do not prove it.

## Finding reproduced from the call graph

The registration route passed a typed phone directly to
`app.register_email_account`, so the unique `users.phone_e164` value was held
before the applicant proved that they controlled the number. The later
`POST /v1/auth/phone` route had the same defect: an authenticated account could
reserve a number with only its own password, and the 409 result exposed whether
that target number was already attached to another account.

Email verification did not cure either defect. It proves the mailbox, not the
phone. `POST /v1/auth/phone-verification` checked Firebase only after a number
had already been stored.

## Source repair

- Password registration now creates the required email account without writing
  the optional phone sent by an older installed client. It validates that legacy
  field and reports `phoneVerificationRequired`, but never uses it as a login
  identity or uniqueness reservation.
- The current sign-up interface asks only for the mandatory email. After mailbox
  confirmation it offers the existing phone-verification screen.
- A missing phone is now linked only after Firebase returns a recent signed phone
  proof. The server derives the number from that proof rather than accepting a
  client phone field.
- Password reauthentication, phone attachment, ownership persistence and audit
  recording run in one database transaction. A bad password, duplicate number,
  stale proof or persistence failure leaves `users.phone_e164` unchanged.
- Web or an unconfigured native build cannot fall back to the old password-only
  link form. Existing accounts that already contain an unverified phone retain
  the separate proof route, so they can remediate without changing identity.
- Test fixtures attach synthetic phones explicitly after email registration.
  That fixture setup is not reachable through a production HTTP route.

No migration or provider setting changed. `app.attach_account_phone` remains a
restricted auth-plane primitive, but its public API caller now invokes it only
after the server validates Firebase proof and rolls it back unless
`app.record_verified_phone` succeeds in the same transaction.

## Evidence in this workspace

- API and mobile TypeScript checks: PASS.
- Targeted ESLint and `git diff --check`: PASS.
- Complete mobile suite: **1,060/1,060 PASS across 154 files**. The focused
  sign-up/phone cases were 20/20 and cover Saudi local-number normalization, no
  API write before proof, the proof-bound link payload, success only after the
  server response, and absence of a link form when verification is unavailable.
- Shared/core and non-PostgreSQL API checks run in this workspace: **319 PASS**,
  including the 21 reviewed API-contract cases and 10 account-email HTTP cases.
- PostgreSQL route cases were added for: no pre-proof reservation; atomic
  link+verify followed by phone login; wrong-password rollback; and duplicate
  rollback. The first exact-head CI run exposed that the shared fixture passed
  Saudi local-format numbers directly to an E.164-only database primitive, and
  that the new proof-first cases had not completed their required mailbox proof.
  The fixture now canonicalises the number and those cases explicitly confirm
  the synthetic mailbox first. This is a test-environment correction, not a
  relaxation of either production proof gate. This local image has no `psql`,
  so the corrected cases still require exact-head CI on PostgreSQL 16 and 17
  before this repair can be accepted.

These tests are source and deterministic screen-boundary evidence. They are not
evidence that an SMS reached a physical Saudi number or that the native Firebase
challenge rendered successfully on an iPhone.

The supported cloud-browser tab refresh was retried after the source checks and
again timed out at 20 seconds. No visible browser walkthrough is claimed; this
remains an acceptance gate rather than being replaced by the 1,060 mobile tests.

## Remaining boundary

This closes unproved **phone** reservation and phone-number enumeration through
the link conflict. Registration still returns 409 for an existing **email**.
Removing that mailbox-existence channel safely requires a two-phase,
proof-before-account email-registration protocol; returning a fake success from
the current endpoint would strand a new user because only newly created accounts
receive sessions. The remaining email-registration enumeration stays open and
must not be represented as fixed by this change.
