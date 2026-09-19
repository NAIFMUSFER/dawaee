# Browser acceptance follow-up — 2026-09-19

Baseline: PR #32, production `63b5b8d`, iOS 0.1.0 (6). This is an incomplete acceptance pass; automated checks below do not replace the remaining browser/device work.

## APNs follow-up after explicit approval

- User approved creation and upload. Registered APNs key `SDDPGMN9LW`, Production / Topic Specific `app.dawaee.mobile`, team `A92SD96D4Q`; Expo now lists that key on `@naif789/dawaee`'s iOS configuration. The private key is not included in source, logs, this report, or PR text.
- Added **04:35 Riyadh** to the existing same-day synthetic medication through the live schedule editor and its confirmation dialog. Existing recorded doses were retained.
- Production push was accepted at **2026-09-19 01:35:49Z**; Expo returned a ticket, with no `InvalidCredentials` error. A direct read of that ticket's Expo receipt returned **`status: ok`**. The worker will reconcile receipts after its existing 15-minute delay. Provider acceptance does not prove lock-screen display; awaiting the user's physical-device confirmation.
- Prepared iOS build 7 on source commit `bed05a8` (local build-number base 6, EAS auto-increments). Build ID `c724ccc6-b4d8-49b1-aa87-8e452718b90e` is running with `ios-testflight`, iOS only, production environment. **Automatic submission is off.** Automatic approval review rejected starting with auto-submit because TestFlight/App Store submission had not been explicitly authorized; the safer build-only action succeeded. Ask for explicit TestFlight submission approval after the build is ready.
- Read the actual Emergency Card and QR screens. Existing QR is disabled; it was not activated, shared, or regenerated. No emergency medical fields/disclosure choices were changed.
- Render plugin lists one workspace, `My Workspace` (`tea-d9qth1iju40c73btab90`). Its tool requires user confirmation of the workspace before further service actions; no web deployment has been initiated.

The earlier preparation-only statements below record the previous checkpoint and are superseded by this section.

## Live patient browser results

- Signed in through the user's browser handoff. Exercised Today, medication lists/filtering, History periods/date navigation/status and medication filters, Family, and Settings.
- Created one explicitly synthetic medication, `اختبار واجهة 19-09`, with a same-day end date and synthetic notes. Existing medications were not edited.
- Added and saved a dose note; verified display in Today and medication detail/history.
- Exercised schedule edit and its confirmation, due-time transition, skip, taken, undo, taken again, and custom one-minute snooze. The two taken synthetic doses reduced stock from 4 to 2. The skipped dose and its note remained recorded.
- Opened caregiver invitation and permission forms, nurse preset/customization, and escalation settings. No invitation was submitted or existing relationship modified. No real caregiver/nurse account acceptance pass has completed.
- Opened phone verification, email/password sign-in and recovery forms. Did not complete a new account, phone ownership proof, or recovery delivery.
- Exercised accessibility size changes and restored the original size; checked web app-lock support/recheck, travel zone, notification preferences and privacy. Opened then cancelled account-deletion confirmation.
- Export from Privacy failed on the production web UI with the mobile-only saving error. History briefly displayed the previous query's rows/counts during a filter/range change. Web Settings displayed an inappropriate native RTL restart banner.

## Confirmed notification failure

The user reported no iPhone alerts, foreground or locked, for 03:55, 03:58 and 03:59 Riyadh tests. Production Expo delivery attempts at 00:55:47Z and 00:59:47Z failed with `InvalidCredentials`: no APNs credentials for `app.dawaee.mobile` in `@naif789/dawaee`. The device registration/session was active; relevant worker jobs were succeeding. Do not infer an attempted push for the quickly confirmed 03:58 dose.

Expo Credentials showed no push key and no saved push keys. Apple Developer sign-in succeeded; an APNs-only, Production, Topic Specific key configuration for `app.dawaee.mobile` was prepared under team `A92SD96D4Q`. **Register has not been clicked and no key has been uploaded.** Browser confirmation is required before creating this security-sensitive access and uploading the resulting private key to Expo.

`local / sent / device_local` delivery rows are bookkeeping, not evidence that iOS displayed an alert. Physical delivery remains unverified.

## Changes in this follow-up

- Foreground Expo notification presentation handler, with a delivery-time signed-in check.
- Refresh the owner's reminder schedule every 30 seconds while the app is active, including changes made on web/by a caregiver. Skip rebuilding an unchanged schedule. Existing session/revision fences remain.
- User-requested medication photos: a large, uncropped image above the confirmation controls, plus thumbnails in other dose cards. Uses the existing authenticated, short-lived image URL endpoint. Previous account/profile/image results disappear immediately; stale responses and image failures do not leave an incorrect image. Missing images keep the existing text/actions. No offline photo persistence is introduced.
- History results are tagged by query scope so changed filters cannot label old rows as new results.
- Web RTL changes no longer request a native restart.
- Web health-record export opens a local print preview with Print / Save PDF and Close, retaining native PDF sharing. Preview contents/styles are removed after close or scope invalidation.

## Validation and remaining gates

Mobile TypeScript and ESLint for changed files passed. Web export built successfully. Five focused suites passed **75 tests**: reminder refresh, notification races/presentation, profile-screen boundaries, native report sharing, and medication-photo account/profile isolation/failure behavior.

The new photo and web print preview have **not** yet been verified in a deployed browser build. A local synthetic HTML preview was blocked by cloud browser URL policy; no alternate route around that block was attempted. The existing production UI pass above predates these source changes. No production deployment or new TestFlight build has been performed in this follow-up.

Next: approve/register/upload the scoped APNs key; verify a fresh production push and its receipt plus user-observed locked-phone display; build/install the native changes and verify foreground display/remote schedule refresh. Deploy/retest new photo, print preview, RTL and history behavior. Complete signup and ownership verification with test identities; patient/caregiver/nurse invitations and permissions; report/emergency flows; remaining upload/camera/barcode buttons. Keep PR draft until acceptance is complete.
