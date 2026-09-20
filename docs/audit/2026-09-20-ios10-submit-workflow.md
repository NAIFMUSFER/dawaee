# Existing iOS 10 upload preparation — 20 September 2026

**Follow-up, 19:04 UTC:** the owner completed Apple sign-in. The automatic
distribution hold was implemented and verified using a manual internal group
with the existing tester/build 6; the automatic group has zero testers.
The pinned workflow ran once and **Succeeded**. Apple independently displays
build **0.1.0 (10), Processing**. No duplicate build, production deploy or
public release was performed. The preparation-only statements below are
historical; see [the actual upload evidence](2026-09-20-ios10-apple-upload.md).

## Verified source and running services

The application source is `e59f864a6ae32ec28276b1b786e64b0621506308`.
Its [CI run 35527946265](https://github.com/NAIFMUSFER/dawaee/actions/runs/35527946265)
and [Security run 35527945996](https://github.com/NAIFMUSFER/dawaee/actions/runs/35527945996)
are both completed/success. Both PostgreSQL jobs and the mobile, Docker,
dependencies and runtime-recovery jobs passed. This supersedes the pending-CI
status in the prior iOS 10 evidence; it is not physical-device acceptance.

Fresh Render inspection found no active deployment. API `srv-dad9mvf10e5c73dva9vg`
is live at `dep-damsvgh42hec73cd22ig`; worker `srv-dad9meijnfac73f1o3tg`
is live at `dep-dane7r8ae00c73efukg0`. Both still use `63b5b8d`.
Their automatic deployment is off. The verified registration client requires
schema 0095; the production baseline remains 0088. Migrations 0089–0095 and the
worker pre-deploy runner were reviewed. No migration or deploy was triggered.
The prior account retirement is unrelated and must not be replayed.

## Written and validated

Added [submit-ios10.yml](../../apps/mobile/.eas/workflows/submit-ios10.yml)
as a manual-only EAS workflow under the existing mobile project. It has one
`submit` job, pinned to the already inspected build
`a9038762-3554-4f76-9b2f-56a3a2930145`, using the existing `ios-testflight`
submission profile (Apple app 6813157983). It has no build job, push trigger,
tester group, public release, credential creation or account operation.

The current official Expo workflow schema, syntax and job documentation were
fetched on 20 September. The workflow validates against that schema. The bundled
validator initially failed compiling the schema's allowed union types; the same
schema was then validated with Ajv 2020, formats, strict mode and
`allowUnionTypes: true`, yielding `valid: true`, no errors. Application files,
the signed archive and `eas.json` are unchanged; a duplicate iOS build is not
needed for this workflow.

## Execution gate discovered

The existing authenticated Expo dashboard supports running a workflow from a
specific Git ref, so a persistent local CLI token is not required for this path.
Commit `ef2c9a4fbd6b49315caa25142e708eab67639f23` was loaded in the Run workflow
form. Expo offered **Upload reviewed iOS build 10** and enabled Confirm. The
form was cancelled without running it; a selectable workflow is not an upload.
The submissions list still contains only the previous three submissions; no
build-10 upload is recorded. The historical successful EAS Submit workflow
provides evidence that this project previously used hosted submission.

However, **empty `groups` does not suppress Apple automatic distribution**.
Expo explicitly documents that the build is also added to App Store Connect
groups with automatic distribution enabled. Thus the earlier “upload first,
attach testers later” sequence requires verifying that existing automatic
distribution is held, or completing the backend and beta acceptance gates
before upload. Do not infer a distribution hold from an empty groups array.

App Store Connect currently renders its Apple sign-in form in the available
browser. Its group settings have not been read. No password, API key, browser
cookie or permanent token was extracted. The Apple upload authorization already
exists; access to check the actual distribution settings is the remaining gate.

References: [EAS submit workflow](https://docs.expo.dev/submit/ios/#automate-with-eas-workflows),
[submit groups and automatic distribution](https://docs.expo.dev/eas/json/#ios-specific-options-1),
[workflow submit job](https://docs.expo.dev/eas/workflows/pre-packaged-jobs/#submit).

## Not executed / acceptance still open

No new native build, Apple upload, tester distribution, production deployment,
merge or final release was performed in this checkpoint. The existing signed
build remains **0.1.0 (10)**. Browser photo/confirmation evidence remains valid
within its documented scope. Authenticated mounted-session revocation retest,
physical iPhone notification and native acceptance remain open.

## Independent preview work completed

The tested application tree `e59f864` was promoted to the existing isolated
preview as `3c5969a9d7a4ad125bb49c43ad391c4fdec1e39c`, preserving preview and
source ancestry. Git's tree comparison reports no difference. Its one automatic
deployment `dep-dao2epfavr4c73asasv0` became **live at 18:37:35 UTC** on
20 September. No second trigger was sent and no accounts were reset.

At 18:38 UTC, `/version` returned the exact preview commit and schema 0095,
and `/health/ready` returned 200/ready. Browser-style `/sign-up` with
`Accept: text/html` returned 200 HTML with CSP and the corrected English text
in its served bundle. Requests without an HTML Accept header returned the
API's 404, so those requests are not counted as successful page checks.
Both corrected Arabic strings were also present after decoding the bundle's
Unicode escapes; this is bundle-content evidence, not an authenticated Settings
screen observation.
After reloading the signed-out browser, Arabic sign-in rendered; its actual
create-account button opened the email registration screen with the same-email
invitation guidance and disabled submission while empty. No account was created.
Error/fatal logs between 18:37:35 and 18:38:37 UTC were empty. These are limited
browser/HTTP deployment checks, not a repeat of all authenticated/native journeys.
