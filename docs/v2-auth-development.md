# TADAWEE v2: authentication development

## Changes

- Login, registration and name onboarding no longer autofocus the first input.
- Login and registration use a scrolling keyboard-avoiding layout. The keyboard opens only when the user selects a field.
- New registration collects name, email and password inside the app. A six-digit emailed code is entered inside the app; no account-completion webpage is required. Supported phone verification continues inside the app after email confirmation.
- Native iOS/Android Google registration and login share the same authenticated session flow. The button appears only when both native configuration and the API capability are available. Web Google sign-in is not implemented by this change.
- Existing email-link endpoints remain available for older app builds and password recovery.

## Required configuration before a device build

No production settings or database were changed during development.

1. Create/locate a Google OAuth Web client for the server and an iOS client for `app.dawaee.mobile` in the same Google project. Configure the consent screen and permitted test users if applicable.
2. Set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` in the mobile build environment. These client IDs are public identifiers; never place a client secret in the app. The Expo plugin derives the reversed iOS URL scheme.
3. Set API `GOOGLE_AUTH_CLIENT_IDS` to the expected Web client ID. Additional accepted audiences can be comma-separated only if deliberately approved.
4. For Android, register package `app.dawaee.mobile` and the build's signing certificate fingerprints with Google. The Web client is still used to request the server ID token.
5. Apply `db/migrations/0101_google_auth_identity.sql` through the existing migration process, then deploy the API/worker-compatible email-code implementation before distributing the new mobile build.
6. Keep the existing account-email provider, encrypted queue and password-login configuration enabled. Email confirmation remains required, using a code rather than an external account page.
7. Rebuild the native app; this native dependency cannot be introduced by a JavaScript-only update or Expo Go.

The supplied Android Firebase configuration contains no OAuth clients, and an iOS Google OAuth client ID was not present in the checked-out project. Google sign-in is therefore implemented but not activated or tested against a real Google account.

## Account rules

Google tokens are checked for signature, issuer, approved audience, expiry and verified email. Google-hosted email is required. Third-party email associated with a Google account uses the existing email/password path. The stable Google subject is stored privately, with restricted SQL permissions. Existing verified Gmail accounts may be associated without replacing passwords. Existing Workspace accounts require a separate future authenticated linking flow to avoid silently linking a reassigned organizational mailbox.

Email challenges create no account until the correct code is supplied. Five guesses are allowed per challenge in a durable database budget; expired codes are rejected. Account completion also verifies the supplied password before creating a session, so a consumed code cannot bypass a subsequent password reset or account suspension.

## Validation and remaining device checks

Automated checks exercise restricted database roles and all migrations, code issuance, completion, expiry, bounded guessing, signed Google token validation and stable identity resolution. API/mobile TypeScript and repository lint are checked separately.

Before release, test a clean iPhone installation in Arabic and English: select a language, confirm keyboard is closed and login/create-account controls are visible; tap and scroll every form with the keyboard open; request/resend/enter a code; complete phone proof on supported builds; cancel and retry Google sign-in; create a Google account, sign out, and sign back in; test existing Gmail and existing email/password users. Check Android separately with release signing configuration. Verify delivery through the actual email provider. Automated tests do not replace these native/device checks.

References: [native Google Expo setup](https://react-native-google-signin.github.io/docs/setting-up/expo), [native sign-in](https://react-native-google-signin.github.io/docs/original), [server token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
