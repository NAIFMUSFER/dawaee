# TestFlight upload preparation — 20 September 2026

## Authorization and scope

The owner explicitly requested upload to Apple after testing the browser invite
and email registration flow. This authorizes preparing and uploading a beta to
TestFlight. It does not remove the existing precise-source verification gate or
authorize a public App Store release. Do not ask for upload permission again.

## Source and checks

Inspected PR #32 at `67ceed730fde8b3584fdacd163e8abb90a615fff`, its workflow
results, local changes, EAS profiles, application identity, iOS preflight and the
registration release contract. Local `bb4178d` has the identical source tree
`a77ea42312f0009107a92b0c32fcee39ce835abf`. Only dependency symlinks were untracked.

CI run [35506974322](https://github.com/NAIFMUSFER/dawaee/actions/runs/35506974322)
failed the same single mobile source-text assertion in both PostgreSQL 16 and
17 jobs (2,912 passing, one failing test per job). The assertion expected the
pre-existing error string literally; the screen now selects the correct iOS or
browser guidance. This was not evidence of a failing database query. The mobile,
container, dependency and runtime recovery jobs passed; the matching
[Security run](https://github.com/NAIFMUSFER/dawaee/actions/runs/35506974330) passed.

Written here: replace that brittle check with runtime screen-boundary coverage
for both platforms. Each case rejects a wrong account, asserts no permissions or
accept button are exposed, switches accounts, reuses the preserved invitation
token for preview, checks no automatic acceptance, then verifies explicit
acceptance clears the token only after server success. Application behavior and
recipient protections are unchanged. This harness is not a native renderer or
a real-device acceptance test.

Local verification: the focused invitation checks passed **10/10 tests in two
files**, followed by the full mobile suite, **1,085/1,085 tests in 157 files**.
Changed-test ESLint and `git diff --check` passed. Publication and exact-head CI
are tracked on PR #32; the failed earlier run must not be represented as a
successful run of this fix.

## Actual upload blockers

- EAS CLI 24.7.0 is installed, but `eas whoami` returns **Not logged in**.
  There is no Expo session or `EXPO_TOKEN` in this execution environment.
  The cloud browser fails before navigation with
  `CDP operation refresh tabs timed out after 20000ms`; listing existing tabs
  and the documented fresh-tab recovery both fail. No authentication page
  loaded, and no password, token or verification code was requested in chat.
- `ios-testflight` uses the production identity `app.dawaee.mobile`, Expo
  project `a7d1638b-045d-4fa3-957f-22d818c51abd`, App Store Connect app
  `6813157983` and team `A92SD96D4Q`. Its configured API was inspected at
  `63b5b8d33a502b8e3d3cd2ca94b1855266665f90`, schema 0088. The updated email
  registration contract needs schema 0095, currently present in the isolated
  preview. The client and its API need coordinated compatibility verification;
  see [the registration gate](2026-09-20-proof-first-email-registration.md).
- The separate `audit-preview` profile uses `app.dawaee.audit` and internal
  distribution. It is not the configured TestFlight application. Production
  identity/backend guards were preserved. No guessed Apple application ID,
  substituted Firebase configuration or APNs-only key was used for submission.

## Remaining execution sequence

1. Restore authenticated Expo access through a functioning secure login surface
   or the execution environment's secret configuration. Never put credentials
   in a PR, commit, chat message or command output.
2. Read current EAS builds/submissions, remote iOS signing and production file
   variables. Do not start a duplicate build. The historical successful build
   `c724ccc6-b4d8-49b1-aa87-8e452718b90e` predates these fixes and is not a
   substitute for a build of the reviewed current source.
3. Verify the repaired exact-head CI and coordinate the updated client/API
   contract before distributing a beta. Choose the next build number from
   actual remote state, not the stale local build number.
4. Build with the existing `ios-testflight` profile and submit its explicit
   build ID with the same submit profile. Record EAS and Apple processing
   results separately; an uploaded build is not proof of device behavior.

## Publication boundaries

No iOS build or submission was started in this preparation. No production deploy,
merge or public release was performed. The existing preview stays on its already
deployed source; a test/documentation-only repair requires no duplicate preview
deployment. Previously completed account cleanup must not be replayed.

## Follow-up: verified source and dashboard build preparation

The repair was published as `bef196d2c3cc2cd3f501942beedbf4d722b396dd`.
Its [CI](https://github.com/NAIFMUSFER/dawaee/actions/runs/35508155261) and
[Security](https://github.com/NAIFMUSFER/dawaee/actions/runs/35508155262) passed.
PostgreSQL 16 and 17 each passed **2,914 tests in 380 files**; RLS reported 110
attempts, zero unexplained failures and zero open findings. Mobile, containers,
dependencies and runtime recovery also passed. These results do not cover a
later changed source until its own verification is recorded.

The owner supplied `IMG_0563.png` showing the Expo project's unfiltered Builds
list: latest visible iOS store build **0.1.0 (7)**, Git ref **bed05a8**, profile
**ios-testflight**, followed by build (6) from `63b5b8d`. The dashboard exposes
**Build from GitHub**. This is owner-supplied evidence of their browser session
and visible build inventory; it does not establish CLI authentication, signed
artifact inspection or submission to Apple.

For the next reviewed artifact, `app.json` now specifies build **8**. Only the
iOS settings of `ios-testflight` explicitly disable inherited auto-increment,
so a dashboard build consumes that reviewed number without repeating build 7
from the stale local number or relying on an uncommitted CLI increment. Android
versioning and the generic production profile retain their previous settings.
Before any subsequent artifact/retry intended for submission, check the remote
build list again and allocate a new number if 8 has already been consumed.

Dashboard build selection, once this preparation is published/checked:

| Field | Value |
|---|---|
| Git ref | Exact published preparation commit recorded on PR #32 |
| Platform | iOS |
| Build profile | ios-testflight |
| Base directory | apps/mobile |
| Store submission | Separate step after artifact/API verification |

The existing production bundle ID, remote signing, production environment,
Firebase preflight and backend remain intact. The production API compatibility
gate above still applies before beta distribution. No old build should be
submitted as a substitute. Selecting the dashboard form is not starting a build;
record its actual build ID and source if the owner starts it.

Local verification of this configuration change: **21/21 existing iOS preflight
and audit-identity tests** passed. The installed EAS CLI 24.7.0 `@expo/eas-json`
parser validated the schema and resolved inherited `ios-testflight` settings to
store distribution, remote credentials, production environment and
`autoIncrement=false`. Executing `app.config.js` yielded version `0.1.0`, build
`8`, bundle `app.dawaee.mobile`; the production Android profile still resolves
to automatic increments and its local versionCode remains 5. Whitespace checks
passed. This is configuration validation, not an Xcode build or real Firebase
credential check.

References checked 20 September 2026:
[Expo GitHub dashboard builds](https://docs.expo.dev/build/building-from-github/)
and [local app-version management](https://docs.expo.dev/build-reference/app-versions/).
