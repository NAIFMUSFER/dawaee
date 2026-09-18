# TestFlight patient feedback follow-up

This branch is based on the tested iOS preparation branch at
`8651749a3a5fcba41af383eac6b948cb3b0c3abf` (PR #31). It is a proposed follow-up,
not a production deployment or a newly uploaded TestFlight build.

## Behavior changes

- Today groups unresolved medication occurrences by their scheduled instant.
  Every medication in a due group has its own confirmation. Future groups have
  no taken/skip/snooze actions. A foreground clock promotes a group when due;
  action handlers also check the time before sending or queueing a write.
  Completed occurrences remain in a separate record, with the existing undo
  window. Caregiver permissions, profile boundaries and offline queuing remain.
- iOS notification authorization includes authorized, provisional and ephemeral
  states. Today refreshes the warning on focus and return from device settings,
  ignoring obsolete permission reads. Notification settings refresh on iOS too.
- Phone verification distinguishes failed account loading from a missing phone,
  accepts Arabic OTP digits and explains provider failures without exposing raw
  errors. iOS uses the configured Firebase Auth instance for its temporary phone
  proof; attempts drain native work and sign out on completion/cancellation.
  Android retains an isolated Firebase instance. App login still uses the API.
- Caregiver invitations render their returned link as an on-device QR. The SMS
  button opens the device Messages composer with the recipient and invitation;
  the user must press Send. Cancellation/unknown results never claim delivery.
  **Automatic server SMS is not implemented or configured.** It needs a selected
  SMS provider, sender setup and a backend delivery integration.
- Unsupported voice reminder/confirmation controls and microphone permission
  declarations are removed. Medication details have a persistent Back button.
- Emergency QR is always reachable from Settings, including simplified mode.
  A newly generated code is encrypted per account/profile on this device and
  redisplayed when its rotation timestamp still matches the API. Disable,
  rotation mismatch and sign-out remove the saved copy. Previously issued codes
  cannot be recovered from the server's hash; generate a new code once after
  upgrading if no saved copy exists. Cross-device retrieval is not provided.
- Export produces a readable Arabic/English PDF of the patient's clinical
  records, with readable text fallback when native sharing is unavailable.
  HTML is escaped, no external resources are loaded, QR credentials are omitted,
  and temporary PDFs are removed after sharing. The existing complete JSON API
  export is unchanged; the PDF is a patient summary, not an audit-log dump.

## Release dependencies

1. Deploy the reviewed API changes with the current audited application lineage.
   The QR enable endpoint now returns `qrRotatedAt`. The email recovery follow-up
   requires migration `0086_account_email_recovery.sql`.
   Older APIs can still show a newly generated code during the current visit,
   but cannot establish its persistent copy through the new response contract.
2. Build a **new native iOS binary**: `expo-print` and `expo-sms` were added and
   microphone configuration changed. An OTA JavaScript update is insufficient.
   The checked-in iOS build number is now 4, matching the tested build;
   `ios-testflight` inherits `autoIncrement: true` for the next number. Verify
   App Store Connect has not already used that number before building.
3. Retain the owner's working local signing setup and real Firebase plist.
   Do not replace local EAS credentials settings or publish credentials.
   Submit to the existing App Store Connect app `6813157983`.
4. Firebase Phone authentication and Saudi Arabia in the SMS region policy were
   observed enabled. No APNs authentication key/certificate was present in the
   inspected Firebase iOS configuration. Configure the appropriate Apple APNs
   credential and test both normal verification and reCAPTCHA fallback. The
   App Store Connect submission key is a different credential. Missing APNs is
   a configuration gap, not proof that it is the sole cause of the reported SMS
   failure. Confirm the deployed API also has the phone-verification routes and
   correct Firebase server configuration.

Firebase setup references:
[Firebase iOS phone authentication](https://firebase.google.com/docs/auth/ios/phone-auth),
[React Native Firebase phone authentication](https://rnfirebase.io/auth/phone-auth).

## Verification and remaining device checks

Focused regressions cover same-time doses, future action blocking and clock
transition, exact occurrence dispatch, permissions/profile races, QR storage and
rotation mismatch, SMS composer cancellation, phone-proof cancellation, report
escaping, PDF cleanup and notification scheduling races. Mobile and workspace
TypeScript checks, changed-file ESLint, shared/core/API/worker builds, web export
and Hermes iOS export were run locally. The temporary generated bundles are not
release artifacts.

Still requires a physical iPhone and the next TestFlight build: actual SMS
receipt for caregiver phone verification, email ownership/reset, notification delivery with app closed,
scanning the invitation and emergency QR, Messages sending, and Arabic PDF
rendering/saving. This work has not changed Firebase/Apple settings, deployed
Render, sent invitations or uploaded a new TestFlight build.

## Email recovery follow-up

The owner replaced Twilio with verified-email password recovery and retained
user-sent Messages invitations. Twilio integration/configuration and its setup
documents were removed. Email setup, database migration, delivery configuration,
security behavior and remaining domain/device checks are documented in
[email-account-recovery.md](email-account-recovery.md).
