# TADAWEE v2 public-update preparation — 8 October 2026

## Native candidates

- Version 1.0.1 (18), commit `684878a78d6c6759ceb849ac4872855790766638`, was built with `ios-auth-preview`. EAS submission `2dadd6a9-9efc-42c7-a9d2-221c711e4c85` succeeded and Apple processed it as Ready for TestFlight. Its API is `https://dawaee-audit-preview.onrender.com`. Do not select this archive for public App Store review.
- The next production candidate is version 1.0.1 (19), using `ios-testflight`. This profile uses the production environment, production app identity `app.dawaee.mobile`, remote signing credentials and `https://dawaee-api.onrender.com`. Its iOS build number is explicit; auto-increment is disabled for this profile.
- Build the production candidate without automatic submission. Building an archive does not establish backend readiness or device acceptance. Record its build ID, exact source commit and inspected archive before uploading or selecting it for review.

## Backend and acceptance gates

Follow `docs/PRODUCTION-RELEASE-RUNBOOK.md` and `docs/release/2026-09-21-candidate-pr-gates.md`. Keep production automatic deployment off. Confirm the production workspace and existing API/worker identities before making any changes.

Before promotion, verify the current production commit/schema, obtain the required backup and production-derived restore rehearsal, and prove installed-build compatibility. Apply migrations `0101_google_auth_identity.sql` and `0102_google_phone_link.sql` through the existing numbered migration runner. Deploy the compatible worker first, verify its normal jobs, then deploy the API at the same exact tested commit. Preserve existing accounts, email delivery and Firebase configuration.

Google sign-in requires the matching approved server audiences and native public client IDs. Production readiness must report the configured capability; successful isolated-preview Google authentication alone does not establish production capability.

Complete the documented real-device checks, including new Google registration followed by phone entry/SMS proof, returning-account login, in-app email confirmation, first-use notification permission and reminder delivery. Native build success and automated tests are separate evidence.

## Current access blockers

The Render connector listed `My Workspace` and `SHAIM` but has no confirmed workspace. Its tool requires the user to identify the target workspace before service operations. Apple requested sign-in again; the secure sign-in request did not complete. No public review submission or production deployment was performed during this preparation.

After these blockers and release gates are resolved, upload the verified production archive to App Store Connect, select it for version 1.0.1, check the actual encryption declaration and existing release metadata, and submit the update for review.
