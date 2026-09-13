# Schedule optional-constraint integrity — 2026-09-13

Base: `13e9df29515fed0ac2ef78dcb41315d88c2f0e72` on PR #14. CI #845 and Security #846 completed SUCCESS on that exact base; Render audit preview deploy `dep-daj8u2nqj5pc73b0jkng` is LIVE on the same SHA. PR remains Draft; no merge or production deployment is authorized by this change.

## Proven defect before correction

A prior isolated actual-screen diagnostic on this branch exercised four invalid optional-constraint cases plus valid/blank controls. `as_needed.maxPerDay = '0'` and `minHoursBetween = '-1'` each produced `{ kind: 'as_needed' }` instead of blocking Save. An interval with only `activeFrom = '08:00'`, or with an invalid/missing companion bound, produced a valid interval payload with both active-window bounds omitted. No live patient or production request was used.

The current screen source at the base confirms the mechanism. In `buildRule()`, interval adds the window only when both values already validate; otherwise it silently returns the base interval. `as_needed` conditionally spreads only values that pass local checks, so a nonblank invalid input disappears from the payload. The shared API contract independently requires interval bounds to be valid times when present, `maxPerDay` to be an integer from 1 through 24, and `minHoursBetween` from 0 through 48. Server validation cannot recover a value the client omitted before submission.

## Minimal correction

- Interval: both optional window fields blank remains valid; both valid remains valid and preserved; any partial or malformed pair makes the draft invalid.
- As-needed: blank optional limits remain omitted; a supplied max must be an integer in 1..24; a supplied minimum gap must be finite in 0..48. Invalid supplied values reject the draft rather than being removed from it.
- No API, schema, authorization, navigation, hydration, high-risk-confirmation, notification, database, or dependency changes.

## Regression coverage

`apps/mobile/test/schedule-optional-constraint-integrity.cjs` executes the actual checked-in schedule screen and request-scope hook through the existing controlled-I/O harness. Its 14 cases cover create and hydrated-edit modes for partial interval windows, malformed interval bounds, out-of-range as-needed limits, fully blank optional constraints, complete valid windows, API boundary values 24/48, PATCH identity, and preservation of invalid input for correction. The Vitest wrapper runs the same bounded shell-free Node suite in normal CI.

The pre-fix failure is already preserved in the PR audit checkpoint that recorded the isolated diagnostic; the new regression file is committed together with the minimal runtime correction. Full exact-head CI/security is required after integration. These screen-boundary tests are not browser/native E2E, physical-device notification evidence, provider receipts, or production acceptance.
