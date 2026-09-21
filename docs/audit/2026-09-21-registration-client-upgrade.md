# F4 / N18 — explicit registration contract boundary

Installed one-step registration clients expected access/refresh tokens from a
successful request. The new mailbox-first API instead acknowledged a pending
link, which an older client could mistake for a usable session.

Requests containing the removed phone/name/password registration fields now
receive 426 upgrade_required with Arabic/English guidance before provider,
schema, budget or credential work. Current email/locale requests keep the 202
mailbox-proof contract. Existing sign-in and refresh are unchanged; this is an
operation-specific gate, not a ban on every request from an older build.

The credential-length test now targets the real password-setting endpoint
(/auth/email/complete), preserving its 400/CPU-bound assertion. Successful
mailbox fixtures use the current payload; legacy-phone fixtures assert refusal.

N18: the email-enumeration fixture now stores and probes the exact created email,
asserts its database identity and successful-password positive control, then
compares known/unknown wrong-password responses. Previously it probed n-1 after
creating n, so two nonexistent identities could make the test pass vacuously.

Validation on Node 22.23.2:
- Before: all five new legacy-contract cases failed; four F5 cases passed.
- After: 131/131 cases in 10 focused API/shared suites, including legacy refusal
  without mail/identity/budget mutation, current mail flow and translation parity.
- Workspace TypeScript, changed-file ESLint and diff check passed.
- Native PostgreSQL fixtures (including N18) await CI; no device UX or installed
  build-6 runtime behavior is claimed. Server responses were exercised directly.

This change builds on F5 capacity repair (PR42). No deployment, account write in
hosted environments or actual email delivery occurred.
