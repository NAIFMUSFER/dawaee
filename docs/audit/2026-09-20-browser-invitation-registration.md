# Browser invitation and email registration — 2026-09-20

## Report and traced cause

The owner reached the email account-creation page after opening a care invitation
created for a phone number. The screenshot is user evidence, not an automated
browser acceptance result. Registration proves a mailbox (migration 0095), while
`security/phone-proof.ts` deliberately has no web phone-verification adapter.
The shared invite screen nevertheless allowed phone invitations on web.
An email-only account cannot claim the phone-bound grant. Weakening recipient
matching or automatically accepting the invitation would be incorrect.

Reviewed baseline: PR #32 `7dc754e2703c223e3650132fc2fab6035d49518f`, with CI and
Security scan both successful. Local `51f07cc` has the identical tree
`c367089a726afb25e7a87e48bb4fe2c796e4f68c`; the only pre-existing untracked items
were dependency links. Preview was `10eac842`, with no deploy in progress.

## Written

- Web `caregiver/invite.tsx` now requires the recipient's email and blocks phone
  input before submitting. Native keeps its phone-or-email behavior. Web no longer
  offers an SMS channel that would lead a new browser user to an unsupported proof.
- AR/EN hints connect the invited email to sign-up/sign-in and the incoming
  invitation on Today. Sharing remains manual; no automatic invitation email is
  claimed or sent. Existing links and QR sharing continue to work.
- Signed-out invitation review has explicit sign-in and create-account choices.
  A mismatched browser account gets recovery guidance for old phone invitations;
  it cannot view or accept the grant. Only explicit consent grants access.
- `/account-email` now explains the registration link's 30-minute lifetime and
  reveals an actual same-origin sign-in link after successful completion. The
  success message explains using the same email and reviewing the invitation.
  Fragment removal, CSP, no-store, explicit submit and error handling remain.
- Existing phone invitations are not silently rebound. The patient can revoke an
  unusable phone invitation and create a new invitation for the intended email.
  No live account, relationship, permission, credential or session was changed.

The existing `pending_caregiver_invitation_previews` path on Today/Family finds
email invitations created before registration, even when the registration link
opens another browser tab. This avoids persisting an invitation bearer in plain
browser storage. No API contract or migration changed.

## Tested

- Three regression cases failed before the fix (web recipient input, normalized
  email submission, and the account-page return path), then passed after it.
- **94/94 tests across 9 files** passed: account-email SQL and HTTP, invitation
  flow/review, web recipient validation, native phone verification, authentication
  screens, sharing and profile-switch races.
- Two new real PGlite SQL journeys cover a caregiver and nurse registering only
  by email after their invitation was created. The new account has no phone;
  only its mailbox sees the pending grant; an unrelated account sees none;
  access stays denied until explicit reviewed acceptance.
- Shared, API and mobile TypeScript checks passed; changed-file ESLint and
  `git diff --check` passed. Initial missing Node types/PGlite were broken local
  dependency links; repairing those links restored the checks without changing
  any dependency version or lockfile.
- Fresh Expo web export and HTML inlining passed (1,035 modules).

## Publishing and limits

This source checkpoint records completed local checks. Publication and the
preview's actual live commit/deploy must be recorded separately in PR #32 after
verification. Do not reuse previous-head CI as evidence for this change.

The controlled browser still fails before navigation: `CDP operation refresh tabs
timed out after 20000ms`. Consequently this is not a rendered browser journey,
mobile Safari acceptance, iPhone notification test or App Store approval. No
registration/recovery email was sent in this work. Production, native binaries
and TestFlight are outside this preview correction; PR #32 remains unmerged.

## Previous operational follow-up resolved

An independent Render read confirms the existing preview is **Free**, updated
`2026-09-20T10:49:46.748988Z`. Deploy `dep-danrjfmgekts739u9odg` of the unchanged
`10eac842` became live when the plan changed. The old Free-restoration blocker is
resolved; no further upgrade/job is needed. The completed account reset must
never be replayed, including for accounts created during the owner's current test.
