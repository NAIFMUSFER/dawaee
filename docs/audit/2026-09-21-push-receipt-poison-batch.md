# N8 — push receipt poison-batch isolation

Date: 2026-09-21

Base: `dd5722f790416bbcc0077c5ce7a32d57246bdab0`
(`audit/repair-batch-verified-20260921`, draft PR #47)

## Finding reproduced

`push-receipts` selects the oldest 100 sent deliveries before validating the
stored Expo ticket objects. A complete batch with non-empty JSON arrays but no
valid ticket was selected again on every tick. The job returned
`itemsProcessed: 0`, so a valid delivery ordered immediately after the batch
could never reach the provider receipt lookup.

The new controlled test creates 100 malformed stored deliveries followed by
one valid delivery. Before the runtime change its only scenario failed:

- expected the 100 terminally invalid rows to advance;
- received `itemsProcessed: 0`;
- the valid 101st delivery remained blocked.

No external provider, device, account, notification or production database is
used by this reproduction.

## Written

- `apps/worker/src/jobs/push-receipts.ts` now classifies a selected delivery
  with zero valid stored tickets as `failed`/`push_receipt_malformed` in one
  bounded update. The stored corrupt value is never copied to `error_detail`.
- Progress already committed for malformed rows is retained in
  `itemsProcessed` even when a provider call for other rows fails.
- `apps/worker/test/push-receipt-poison-batch.test.ts` proves that the poison
  batch is removed from the queue and the following valid receipt is delivered
  on the next bounded job invocation.

The existing receipt delay, 24-hour expiry, affirmative-delivery requirement,
token-fingerprint guard and provider error handling are unchanged.

## Tested

- Red reproduction before the fix: 1 failed / 1 total.
- Focused after the fix: 3 passed / 3 total
  (`push-receipt-poison-batch`, `expo-push-receipts`).
- Wider receipt/worker selection after rebuilding shared/core/API/worker from
  this source: 63 passed / 63 total across 11 files. An earlier invocation ran
  the liveness subprocess against a stale ignored `dist`; that precondition
  failure disappeared after the source build and is not counted as a product
  pass or failure.
- Worker TypeScript: pass.
- ESLint for both changed TypeScript files: pass.
- `git diff --check`: pass.

## Published / deployed / device evidence

- GitHub: not published at the time this note was written.
- Preview and production: not deployed.
- Native build or physical-device delivery: not run and not implied by these
  deterministic tests.
- A real Expo/APNs/FCM receipt remains provider evidence, not proof that a
  person saw an alert. Physical-device notification acceptance remains open.
