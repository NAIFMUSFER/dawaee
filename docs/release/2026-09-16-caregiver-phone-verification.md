# Caregiver phone ownership verification

This candidate builds on PR #26 at `4265c787`. Password registration still
creates a usable personal medication account, but is not proof of phone
ownership. Firebase Phone Authentication supplies that separate proof.

## Changes

- The API validates Google's RS256 signature, the `tadawee` issuer/audience,
  required expiry/issued-at claims, a phone sign-in and an authentication time
  no older than ten minutes. The proof must match the signed-in account's
  canonical phone. Tokens are not stored or included in audit records.
- Migration 0082 adds a private, RLS-protected verification record and applies
  it to invitation acceptance and caregiver permissions. Existing accounts are
  not backfilled as verified. Patient/owner access is unchanged.
- Existing caregiver relationships are retained. Access to another person's
  records and caregiver notification delivery require verification; they
  resume after verification. This is a coordinated rollout requirement.
- The Android screen sends SMS only after the user's explicit action and
  disclosure. It handles manual codes and Android automatic verification,
  cancels stale attempts and records success only after the API confirms it.
- The screen is reachable from invitation acceptance and Settings. Invitations
  remain pending while verification is completed. Web/iOS users can use an
  already verified account; verification currently requires the configured
  Android application.

## Firebase and build identity

The existing Firebase configuration from PR #25 is reused: project `tadawee`,
Android package `app.dawaee.mobile`. ACS's separate Firebase configuration is
not used. The audit installation `app.dawaee.audit` does not reuse the production
Firebase application configuration. It needs its own registered client before
it can perform real phone verification.

Read-only console checks on 2026-09-16 confirmed Phone Authentication is
enabled, the SMS region policy allows Saudi Arabia, and the configured Android
client has SHA-1 and SHA-256 certificates registered. The console displays a
ten-SMS-per-day quota for this project. These observations do not prove delivery.

Before production cutover, match the installed artifact and Google Play signing
certificates to Firebase, then verify real delivery and automatic/manual
confirmation on a signed Android device. No real SMS or device verification has
been performed. Android versionCode is now 4, above the previously built store
artifact's versionCode 3, so this candidate does not use a lower version number.

The candidate also includes the exact migration 0078 portability repair from
PR #27: use PostgreSQL's core SHA-256 function rather than requiring pgcrypto.
This removes that known source dependency; the production migration/recovery
and coordinated rollout gates still require their own evidence.

References: [Firebase Android phone authentication](https://firebase.google.com/docs/auth/android/phone-auth)
and [server ID-token validation](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

## Deployment boundary

Do not deploy this migration ahead of a usable verification client without a
coordinated rollout: existing unverified caregivers would lose access and
alerts until they verify. No active relationship or consent is deleted.
Production migration/recovery, coherent API/worker rollout, remote signing and
installed-device notification gates still apply. PR #28 remains the separate
no-migration compatibility repair for the currently serving API.

Tests use synthetic accounts and a controlled provider boundary. Clinical
integration fixtures explicitly establish verified ownership; the new
verification lifecycle suite starts with an unverified password account.
Passing tests do not claim that a real SMS was sent or received.
