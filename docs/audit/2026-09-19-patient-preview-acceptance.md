# Patient preview acceptance — 2026-09-19

This records real cloud-browser interaction, not an automated-test substitute.
The user completed authentication through the browser handoff. No credentials
were read, copied, generated, or inserted by the auditor. The display name was
`test`; no contact identifiers are included here.

## Candidate and environment

- Patient trials below used preview merge `cb7960bb06516d5d91b6c0c81c8492240373a788`,
  the exact `02748eb` candidate tree.
- The isolated preview uses mock push/OCR and ephemeral local image storage.
  These trials do not establish APNs delivery or production S3 persistence.
- The next auth-startup candidate `ae3805bf1688d3bbed4e4401fc496a096cbf910f`
  passed CI run **35444260866** and Security run **35444260865**. PostgreSQL 16
  and 17 each passed **2,801 tests / 370 files**, including 110 RLS attempts with
  zero unexplained failures or open findings. Mobile, dependencies, Docker and
  runtime recovery passed. Exact-tree preview merge `a205ef36dc3166151e73205df292391be1a1ead6`
  became live in deploy `dep-dan8gknavr4c73a6s6u0` at **13:06:41 UTC**.
- Production remains `63b5b8d`; TestFlight remains 0.1.0 (6). No final submission.

## Observed patient results

| Interaction | Observed result |
| --- | --- |
| Add medication through manual entry | Synthetic `اختبار الصورة والملاحظات 19-09` saved through the UI; POST /v1/medications returned 200 at 12:53:04 UTC. |
| Image upload | Uploaded the repository's own app icon as an explicitly synthetic recognition image; image appeared above due-dose confirmation controls and as a History thumbnail. |
| Schedule | Daily all seven days at 15:54 Asia/Riyadh, starting September 19; due card appeared. |
| Arabic number | Stock input `١٠` persisted and displayed as 10 tablets. |
| Medication note | Saved note appeared in medication detail, Today and History. It explicitly says it is test text, not treatment guidance. |
| Dose note | Saved `ملاحظة جرعة اختبار: يجب أن تظهر في السجل بعد التأكيد.`; the modal confirmed save and read it back with a timestamp. The exact note also appeared on Today, medication detail and History cards. |
| Taken | Dose left awaiting confirmation, appeared in today's record as taken; medication detail showed 9 tablets remaining. |
| Undo taken | Dose returned to awaiting confirmation; medication detail showed 10 tablets and no completed dose history. Dose note remained. |
| Custom snooze | Entered Arabic `١` minute and confirmed; Today and History displayed snoozed. No physical alert was expected/proven in mock preview. |
| Skip | Dose changed to skipped in Today and the independent History screen; note remained visible. |
| History filters | Taken filter excluded the skipped dose and showed the empty-filter result; skipped filter restored the correct card. Clear-filter and day/week/month navigation controls responded. Month displayed the skipped September 19 dose and upcoming daily doses. |
| Family | Empty care circle displayed correctly before the reload finding below. Full invitations/recipient acceptance remain pending. |

Evidence contains only synthetic test data:

![Recognition image and medication note on due confirmation card](evidence/2026-09-19-dose-photo-note.jpg)

![History with medication note, dose note and image](evidence/2026-09-19-history-dose-note.jpg)

## Reload finding and repair

After the new preview deployed, a direct navigation to `/family` ended the
memory-only web session as designed. The application nevertheless mounted its
tabs: Family claimed no followed patients, and Today showed a greeting with no
name or usable content. There was no sign-in/recovery transition. Navigating to
the canonical root did show language selection and sign-in.

`app/index.tsx` had a session/recovery gate, but the root Stack allowed direct
navigation to all private routes. `token-store.ts` intentionally does not
persist web tokens, so moving them into localStorage is not the repair.

The root now uses `AppNavigator` with Expo's existing `Stack.Protected` contract
for tabs, medication, reports, private caregiver/settings screens and reminder
landing. The first available destination is the existing index, preserving its
neutral retained-session recovery behavior. Auth, invitation capability/accept
and explicitly shared emergency-card routes remain public. The existing app
lock, email verification gate, server authorization and RLS remain in place.

The installed Expo Router 55 implementation and the official
[protected-routes documentation](https://docs.expo.dev/router/advanced/protected/)
were checked; no SDK 58-only `redirectTo` API is used.

Local verification: 40 focused tests passed (route inventory, clinical
auth/URL boundaries and auth screens), mobile TypeScript and changed-file
ESLint passed. The inventory test compares the navigator against actual route
files, so a new private route cannot silently fall outside the declared guard.
Deployed direct-URL acceptance is pending at this checkpoint.

## Remaining acceptance gates

- Reauthenticate the test patient after reload; do not claim the empty tabs are
  an authenticated session. Browser credentials require the secure user handoff.
- Exercise the newly guarded deployed direct URLs, public invitation entry and
  recovery paths, then resume the remaining patient controls.
- Complete caregiver and nurse registration/verified identity, invitation
  acceptance, permission changes/revocation and patient-profile isolation in
  real interfaces.
- Complete actual email/phone login and recovery delivery, exports/print,
  image replacement/removal, remaining medication/settings controls.
- Complete physical iOS foreground/locked/offline notification, tap routing,
  photo/camera/share/app-lock trials on the audited build before final release.
