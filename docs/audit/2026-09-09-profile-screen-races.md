# Profile-scoped screen response races — evidence-backed remediation

Baseline: `8a59c9062d3690fbfaf72a065e6156376eef09f7` on `audit/e2e-red-white-black-2026-09-09`. PR #14 remains DRAFT. No production writes, migration, merge, deployment, provider calls or paid AI/OCR requests were made for this reproduction.

## Proven before changing runtime code

The local copies were verified against Git's blob hash, including trailing-newline identity:

| Baseline source | Blob SHA | Defective boundary |
| --- | --- | --- |
| `apps/mobile/app/(tabs)/today.tsx` | `a78882f7f99c789da91eb5536975df2600dd0aa0` | lines 73–137: API/cache results and finally update state without checking the selected profile/request; action completions call the captured load |
| `apps/mobile/app/(tabs)/medications.tsx` | `3697af74f5b72cf6d1bbceed5a6a0261f2b2df51` | lines 31–56: Promise.all results overwrite medications/next doses and offline/loading flags |
| `apps/mobile/app/(tabs)/history.tsx` | `f25780469dfc9b06d0bce3689e88e28c56de3867` | lines 144–176: the previous profile can overwrite doses, medication filters, error and loading state |

Deterministic sequence: start A -> select B -> complete B -> complete delayed A. Synthetic A clinical data replaces B despite the selected profile remaining B. Separately, already-rendered A data survives the first B render before passive effects. History also sends A's selected medication id on B's history request. A late NetworkError/finally can change B's offline/loading indicators. Same-profile reloads have the same last-completion-wins defect.

The standalone test runner executes the actual TSX source and actual request hook, with controlled HTTP/cache promises and a small hook/keyed-root lifecycle harness. Host presentation components and React's rendering machinery are simulated. These are screen-boundary regressions, NOT device/browser E2E and NOT evidence of an actual production privacy incident or server RLS bypass.

On the hashed baseline: **32 failures / 10 passes, 42 cases**. After the fix: **42/42 pass**, repeated in three independent local runs. Current-profile success/offline and unchanged-identity controls remain included. Full CI on the new commit must be checked separately; this document does not declare it green in advance.

## Minimal fix

- Key only each clinical screen's inner component by account/profile/permissions/timezone, not the navigator. This clears old patient state, dialogs and medication-specific filters in the first new-profile render.
- `useRequestScope` invalidates in-flight work on unmount/query change and permits only the latest started load to update state. A -> B -> A cannot revive the first A operation.
- Fence response, cache fallback, post-cache notification scheduling, errors and finally blocks. Do not start a stale load after an old dose action completes.
- Preserve an already-started offline action when switching profiles within the same account: enqueue the original dose action, but do not update the new profile's UI flags. The existing API session boundary and account-scoped queue remain responsible for account changes.
- A missing active profile exits loading instead of spinning indefinitely. No permissions, API contracts, dose rules, storage encryption or database policies were changed.

## Reproduction commands

At repository root after dependency installation:

```sh
node apps/mobile/test/profile-screen-scenarios.cjs 'apps/mobile/app/(tabs)'
npx vitest run apps/mobile/test/profile-screen-races.test.ts
```

For the red comparison, run the same standalone runner against the three baseline TSX files. The before/after evidence package contains the exact hashed files and outputs. The optional second runner argument is the request-hook path; `TYPESCRIPT_PATH` can identify an existing local TypeScript installation without downloading dependencies.

## Explicit remaining audit gaps

This closes only the proven Today/Medications/History screen-boundary cases when automated gates pass. It does not close other profile-scoped forms/screens, complete offline reboot/bootstrap restoration, already-running native notification scheduling versus logout/privacy changes, physical iOS/Android lock-screen delivery/actions, live OCR/object-provider lifecycle, real caregiver-device escalation/revocation, or the separately reported production proxy/client-address observation. Those need their own evidence and regression boundaries. Production log access in this session remains gated by Render's requirement for a user-confirmed workspace; no workspace was selected on the user's behalf.
