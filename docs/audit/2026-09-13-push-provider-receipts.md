# Push provider receipt reconciliation — 2026-09-13

## Finding

Baseline: `970a1e273ad539687c6f8a9cb565bb95ec7867b1` on PR #14.

The dispatcher treated an Expo push ticket with `status: ok` as `sent` and stored
one ticket id, but no worker path ever called Expo's receipt endpoint and
`notification_deliveries.delivered_at` was never advanced from provider evidence.
A ticket proves Expo accepted the notification for processing; it is not the
later APNs/FCM delivery result. The schema already had a distinct `delivered`
state and `delivered_at`, so leaving that reconciliation absent made the release
acceptance claim stronger than the recorded evidence.

## Correction

- `PushProvider` gains an optional receipt contract; Expo implements the official
  receipt endpoint and omits missing IDs so the worker retries instead of
  inventing a result.
- Successful push tickets are persisted atomically with the `sent` transition as
  bounded JSON containing only provider ticket id + internal push-token UUID.
  Push-token secrets are not copied into delivery metadata.
- A new worker reconciliation job waits 15 minutes before polling receipts.
  Any affirmative receipt marks the user-level delivery `delivered`; all-terminal
  receipt errors mark it `failed`; unresolved receipts stay `sent` until the
  24-hour provider retention boundary, then fail closed as expired.
- `DeviceNotRegistered` receipts retire only the exact internal endpoint that
  produced that ticket through a narrow SECURITY DEFINER helper. Auth-session
  rows remain inaccessible to the worker.
- Existing immediate ticket errors, retry/backoff, privacy re-checks and delivery
  lease behavior remain unchanged.

## Regression coverage

`apps/api/test/expo-push-receipts.test.ts` checks the exact receipt endpoint,
Bearer transport, ok/error mapping, missing receipt behavior and HTTP failure.

`apps/api/test/push-receipts.test.ts` uses the real PostgreSQL migrations,
dispatcher and worker with the mock provider to prove:

1. ticket acceptance leaves a delivery `sent` with `delivered_at = NULL`;
2. a later affirmative receipt advances it to `delivered`;
3. a terminal `DeviceNotRegistered` receipt marks the delivery failed and
   deactivates the exact push endpoint.

Full CI/security on the resulting SHA is required before this finding is closed.
This does not prove physical-device OS delivery and does not replace the final
real-provider/device acceptance test.
