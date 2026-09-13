# Stock hydration and refill cost integrity — 2026-09-13

## Baseline and scope

- PR #14, branch `audit/e2e-red-white-black-2026-09-09`.
- Baseline HEAD: `702e7ddeb7be3f33c66536a34d4cbdd166c958b7`.
- GitHub directly confirmed CI #846 and Security scan #847 completed successfully on that HEAD before this change.
- Only `apps/mobile/app/medication/stock.tsx` runtime code changes. No API, schema, authorization, shared contract, dependency, workflow or production configuration changes.

## Proven behavior before remediation

The stock screen waits for stock and medication-detail GETs together. If either rejects, `loading` becomes false while `data` stays null. The old render then reports untracked stock and empty histories while exposing Refill. The actual screen tests open that form and submit a positive quantity: a POST is recorded with the default `tablet` unit despite failed hydration. A failed refresh after an adjustment also leaves stale stock write controls available.

A supplied non-numeric/non-finite refill cost is silently changed to null. Negative and over-limit costs are also sent rather than rejected in the form. The existing `refillSchema` in `packages/shared/src/contracts.ts` requires a supplied cost to be between 0 and 1,000,000; this change does not modify that contract. No server-side acceptance of out-of-range costs is claimed.

## Regression evidence

The unchanged repository TSX and request hook are executed with the existing controlled-I/O `profile-screen-harness.cjs`. Before the fix, the new suite reports **21 tests: 9 pass, 12 fail**. Failures are behavioral assertions, including observed refill POSTs after failed hydration, not missing mocks or dependency failures. After the fix, the same suite reports **21 tests: 21 pass, 0 fail**.

Command from the repository root:

```sh
node --test --test-reporter=tap apps/mobile/test/stock-load-refill-safety.cjs
```

A Vitest wrapper includes the suite in the existing CI and checks the exact test/pass/fail counts. These local results are not a claim that full CI or a native/device/browser E2E run has passed.

Coverage includes both GET failure locations with network/API errors, partially completed hydration, missing route intent, successful `stock: null`, explicit retry, failed post-adjustment refresh without replaying the committed write, six invalid cost values, five valid optional cost controls (blank, whitespace, zero, comma decimal and upper boundary), and profile-switch isolation with the correct medication and loaded unit.

## Remediation

- Loading hides write controls on every load attempt; a failed read invalidates stock data.
- The failed-load state shows the error, explicit Retry and Back rather than false empty/untracked state.
- Adjustment and refill handlers require loaded data and no active load.
- Valid `stock: null` remains a successful, untracked response, not a transport failure.
- Explicit invalid costs stay in the draft with validation feedback and cause no mutation/snooze clearing. Valid optional costs preserve their existing meaning and serialization.
- Retry only rereads; it does not repeat a previously committed adjustment/refill.

## Release status

New-head CI/security and preview identity must be checked after the commit. This change does not close production privacy cutover/Render platform request-log verification, physical iOS/Android acceptance, provider delivery receipts, OCR/object-storage acceptance, or offline/multi-device acceptance. PR remains Draft; no merge or production deployment is authorized by these test results.
