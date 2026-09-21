# N2 — Expo HTTP 429 retry repair (2026-09-21)

## Source / coordination

Base candidate: `75a826b7db89cd940a3f4153d6aa038ae4881be0`, whose CI
35601095922 and Security 35601095944 were rechecked as successful. PR #32
remains draft at `e59f864`; neither those checks nor the candidate checks
automatically validate this new source.

The concurrent worktree is restoring app-switcher, logout, offline-cache and
readiness repairs. This independent branch changes only Expo HTTP error
classification and its tests. Supplemental readiness work is checkpointed in
`1d7d02e`; it is not a competing merge candidate.

## Confirmed defect / linked path

`ExpoPushProvider.send` in `apps/api/src/providers/push.ts` returned
`retryable:false` for HTTP 429. The dispatcher's `sendPush` propagated this to
`dispatchJob` in `apps/worker/src/jobs/dispatcher.ts`, which finalized the
delivery as `failed`, even on the first attempt. Ticket-level
`MessageRateExceeded` already supported retries; HTTP-level throttling did not.

[Expo's official sending guidance](https://docs.expo.dev/push-notifications/sending-notifications/),
checked 2026-09-21, identifies HTTP 429 as temporary and recommends exponential
backoff. No real provider call was used to reproduce the defect.

## Written

- Classify HTTP 429 as retryable, including non-JSON error responses.
- Reuse the durable dispatcher's existing delay: 30, 60, 120, 240, then at most
  300 seconds. No inline retry loop, new scheduler or schema migration.
- Preserve maximum attempts, lease-token guarded writes, terminal HTTP
  400/401/403 behavior, and token invalidation only for actual dead endpoints.
- Successful provider tickets remain `sent`, not `delivered`.

This is the bounded backoff repair only; custom `Retry-After` header handling,
cross-device partial-send retry policy and actual device delivery are not
claimed as implemented or verified by this change.

## Verification

- Before fix: 7 expected failures / 11 passes across the new provider and
  dispatcher regressions. All five delay cases incorrectly finalized `failed`;
  both provider 429 cases incorrectly returned `retryable:false`.
- After fix: **33/33** cases passed in four suites: push-send-shape,
  expo-rate-limit-dispatch, expo-push-receipts, caregiver-push-envelope.
- Workspace TypeScript, changed-file ESLint and `git diff --check`: passed.
- The provider and worker code execute with synthetic HTTP and controlled SQL
  responses. This proves the selected retry branch, delay parameters, lease
  fencing, maximum-attempt termination, and ticket state, not native PostgreSQL
  concurrency or push arrival on a device.
- `notification-privacy-retry.test.ts` could not initialize because local
  `psql` is absent. Its case was skipped by failed setup and is not counted
  as passing. Full PostgreSQL 16/17 and runtime-recovery CI remain mandatory.

## Publication / remaining gates

At this local checkpoint, no deployment or native build has occurred. Submit
the independent branch as a draft PR for full CI and review; do not merge or
deploy based solely on the focused tests. No accounts, sessions, credentials,
notifications, mail or hosted settings were changed. UI and physical-iPhone
acceptance remain separate; neither was performed for this backend-only repair.
