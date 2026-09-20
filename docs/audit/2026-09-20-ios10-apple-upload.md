# iOS 10 Apple upload and distribution hold — 20 September 2026

**Follow-up, 19:30 UTC:** Apple processing was independently confirmed Complete
at 19:12. The matching `e59f864` worker/API are now live in production with
schema 0095 and passing readiness. This resolves the backend mismatch described
below; it does not certify native acceptance or change tester distribution.
See [the production incident/update evidence](2026-09-20-ios10-production-backend.md).

## Verified before upload

The owner completed Apple sign-in in the shared browser. App Store Connect
then showed the authenticated app list and app `6813157983`. PR #32 remained
at `e59f864a6ae32ec28276b1b786e64b0621506308`; its CI `35527946265` and
Security `35527945996` were both completed/success. The working checkout had
no unpublished application edits, only the existing dependency symlinks.
The evidence branch was `7b2842d4023760e59b371689fc7f325039344ca7`.

Apple and Expo both showed only the previous uploads for builds 4, 5 and 6.
There was no existing upload of build 10. The reviewed artifact is
`a9038762-3554-4f76-9b2f-56a3a2930145`, version `0.1.0 (10)`, built from
`e59f864`; its prior archive inspection is recorded in
[the iOS 10 evidence](2026-09-20-phone-guidance-ios10.md).

## Distribution hold executed and verified

The existing internal group `TADAWEE Internal`
(`73ededa0-7008-4b12-940d-7a9e133c90d2`) contained one tester and builds
4, 5 and 6. Settings explicitly showed **Automatic for Xcode Builds**.
Apple's group-creation form states that this setting cannot be changed later.
There were no external groups.

Created `TADAWEE Internal Manual`
(`df1ade88-bf5e-4759-a69e-fd936b3f5735`) with automatic distribution unchecked.
Added the currently installed build 6 and the same existing internal tester.
Only after verifying the new membership and build did we remove that tester
from the automatic group. Apple's confirmation explicitly says this does not
delete the tester from TestFlight. No Apple account, app account, build or
group was deleted.

Read-back before submission confirmed:

| Group | Distribution | Testers | Builds |
|---|---|---:|---|
| TADAWEE Internal | Automatic | 0 | 4, 5, 6 |
| TADAWEE Internal Manual | Manual | 1 | 6 |

Build 10 must not be added to the manual group until the matching backend is
ready and the beta acceptance gate is satisfied. Do not put testers back in
the automatic group while it contains a held build. Empty EAS `groups` alone
does not provide this hold.

## Submission execution

Ran the already-reviewed manual workflow once from exact commit
`ef2c9a4fbd6b49315caa25142e708eab67639f23`. It has one submit job pinned to
the existing build ID and no native build job.

- [EAS workflow 01a0c031](https://expo.dev/accounts/naif789/projects/dawaee/workflows/01a0c031-cf45-7b13-baa8-b0742afd754b)
- Created at `2026-09-20T19:01:25Z`.
- Logs confirm download of the exact existing IPA, successful preparation of
  existing remote credentials, and `pilot` upload to Apple app `6813157983`.
- Workflow **Succeeded**, total duration **2m31s**, one submit job **2m05s**.
- [Submission f9e5e8ca](https://expo.dev/accounts/naif789/projects/dawaee/submissions/f9e5e8ca-81bd-451e-9ccf-adc431f3217e)
  was created for this upload.
- Apple independently displayed **Version 0.1.0, Build (10), Processing**,
  created **20 September 2026, 22:03 Riyadh / 19:03 UTC**. This proves Apple
  received the binary; it does not yet establish processing completion.

No permanent CLI authorization, credential extraction or duplicate build was
needed. The existing hosted Apple credential was used by Expo.

## Backend and acceptance remain separate

Fresh Render deployment lists still showed production API
`dep-damsvgh42hec73cd22ig` and worker `dep-dane7r8ae00c73efukg0` live at
`63b5b8d`, with no active deployment. The required API contract/schema 0095
is live in the isolated preview; production is still the documented 0088
baseline. No production deploy was triggered in this checkpoint.

The coordinated sequence remains worker/pre-deploy migrations, verification
of schema and normal worker jobs, API at the identical reviewed source,
readiness and registration checks, then explicit beta distribution. Preserve
the existing migration/recovery requirements. Do not repeat any account reset.

Apple processing and TestFlight availability do not prove notification arrival,
native camera behavior or the mounted-session revocation deadline. These
device/role acceptance items remain open. No public App Store review request,
release, unverified merge or legal metadata declaration was made.
