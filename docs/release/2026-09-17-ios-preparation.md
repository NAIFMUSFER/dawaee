# TADAWEE iOS preparation

Based on `audit/final-tadawee-20260916` at `cfcc4e8db8039b053fb04fe63ee3b46cbabaaa8e` (PR #30), not the older `main`. This change is stacked on the audit branch and must ship with that audited application code.

## Prepared in code

- App identity: تداوي | TADAWEE; iOS bundle `app.dawaee.mobile`; EAS project `a7d1638b-045d-4fa3-957f-22d818c51abd`, account `naif789`.
- `ios-testflight` EAS profile: store distribution, production API, physical-device build, remote signing, incremented build number. It does not submit or publish automatically.
- RN Firebase 26.4's default Swift Package Manager integration uses dynamic frameworks through Expo build properties.
- `GOOGLE_SERVICES_PLIST` accepts an EAS file variable; a local untracked `apps/mobile/GoogleService-Info.plist` also works. Android/web do not require this file.
- Native phone verification/password recovery is reachable through Metro's corrected platform-aware source resolution; iOS support requires its own Firebase registration. A non-secret `extra.iosPhoneVerificationEnabled` capability survives public manifest processing without depending on a build-machine plist path at runtime. Audit identity remains disabled.
- Preflight rejects missing or mismatched Firebase registration, audit identity, and incorrect API target before a signed iOS build. The EAS post-install hook applies it to iOS `production` and `ios-testflight` profiles; development, preview, audit-preview, and Android builds are not subjected to iOS store requirements. An explicit `npm run check:ios` always runs the release validation.
- Existing camera, photo, Face ID, encrypted local storage and remote notification configuration retained. Arabic/English iOS localizations and Arabic home-screen label included.

## Setup still required (step by step with the owner)

1. In the existing Firebase project **tadawee**, register an **iOS** app with bundle `app.dawaee.mobile`. Obtain its actual `GoogleService-Info.plist`. Do not derive an iOS app ID from the Android client or reuse another project's file.
2. Upload this file as the EAS production file variable `GOOGLE_SERVICES_PLIST`, or place it locally at the ignored path. Registering it is required for a release that supports phone verification and password recovery.
3. Register the Apple bundle ID and create the App Store Connect app record. Suggested name: `تداوي | TADAWEE`, primary language Arabic, SKU `TADAWEE-IOS-001`. Record the actual numeric Apple app ID for submission; no invented ID is stored in source.
4. Configure EAS Apple signing and APNs credentials. Configure APNs for Firebase phone verification as well. The RN Firebase auth plugin registers the encoded iOS Firebase app ID URL scheme for reCAPTCHA fallback. Enable Phone authentication and verify Saudi SMS delivery/region settings in the existing Firebase project.
5. From `apps/mobile`, use `npm run check:ios` with the production API environment and then `npm run build:ios:testflight`. Once the build succeeds, use `npm run submit:ios:testflight` and select that exact iOS build/app record.
6. Test on a physical iPhone: fresh install/login, SMS recovery, camera/photo intake, reminders while foreground/background/terminated, taken-dose notification dismissal, Face ID, caregiver verification, privacy export and account deletion. Configure App Store privacy details, reviewer access, screenshots and support/privacy URLs before public review.

The app implements AES-256-GCM through `@noble/ciphers`, in addition to OS transport/storage encryption. No unsupported `usesNonExemptEncryption: false` declaration has been added; answer Apple's encryption questionnaire using the actual implementation.

## Verification scope

Local checks passed: TypeScript, 34 focused configuration/auth/recovery tests across six suites, a Hermes iOS JS export (1,427 modules), and Expo generation of the Xcode project. The generated project contains Firebase startup, the phone-auth callback URL, dynamic frameworks, and the APNs entitlement. Native generation uses a temporary synthetic Firebase plist outside the repository solely to exercise config plugins; it does not establish real Firebase or Apple connectivity and is never a release input.

Apple signing, CocoaPods/SPM resolution and Xcode compilation, upload, APNs/SMS delivery and device execution require the remaining Apple/Firebase setup. No signed IPA or TestFlight link has been produced at this stage.

References:
- https://rnfirebase.io/
- https://docs.expo.dev/build-reference/ios-builds/
- https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/
