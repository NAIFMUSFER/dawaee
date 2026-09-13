# Native notification mutation races

Baseline: `29cfbe4461bef047f0d6cd8a4c7c8ae552a832cd`, notification source blob `5f4c28b4a4d3f955f77301def6f16901d64cac86` (11,474 bytes, exact local Git blob hash verified). The previous profile-screen correction does not make an already-running native scheduling loop atomic.

## Red proof before runtime edits

`apps/mobile/src/notifications/index.ts:142-146` cancels all native notifications independently of `rescheduleLocalNotifications` at lines 185-253. The latter awaits cancel then each native schedule call without invalidating its loop or ordering concurrent operations.

Controlled execution of the actual module reproduced four defects:

1. Hold the first old schedule write -> call logout cancellation -> release the old write: **2 reminders survive**, expected 0.
2. Hold an older named/voice-enabled rebuild -> request a new private rebuild -> release old write: **3 mixed reminders survive**, expected only the latest private reminder.
3. Hold the old rebuild's initial native cancel -> call logout cancellation -> release old cancel: **1 old reminder is recreated**, expected 0.
4. Start two immediate rebuilds together: **2 mixed A/B reminders**, expected only B.

The unchanged test runner has 11 scenarios. Before: **4 failed / 7 passed**. After: **11/11 passed**. Positive controls retain single-dose actions, grouped safety/dedupe, terminal/past exclusion, web unsupported behavior, legitimate new scheduling after cancellation, native-error reporting and recovery after a rejected cancellation.

Reproduction at repo root:

```sh
node apps/mobile/test/notification-schedule-races.cjs apps/mobile/src/notifications/index.ts
npx vitest run apps/mobile/test/notification-schedule-races.test.ts
```

The same runner against the exact baseline source produces the red result. It transpiles and executes the checked-in scheduling module; native I/O is deliberately controllable. Translation helpers use disclosure sentinels, not production translations. Existing reminder-text and privacy suites remain responsible for real text. This is **native-boundary unit regression, not a real handset or complete logout/settings E2E test**.

## Bounded fix

Serialize native schedule/cancel mutations through a promise tail. Increment a generation immediately when a newer mutation is requested, so old loops stop before scheduling further groups. Always run explicit cancellation after any started native write; a failed operation cannot poison later work. Obsolete loops no longer overwrite the exact-alarm capability observation. No notification wording, permissions, action categories, server behavior or dependency changes.

This assumes each underlying native promise eventually settles. It does not claim protection against a permanently hung native module or OS-level behavior that has not been exercised on a device.

## Still open

Callers that have not yet entered the scheduling API (for example a delayed cache read or Today HTTP load carrying old preference values), settings/permission revocation across all callers, native process death/reboot, real push registration/receipt, physical lock-screen disclosure and complete caregiver-device escalation still need separate evidence. Do not mark those E2E checklist items passed based on this bounded fix.

No production write, notification send, merge or deployment was made. PR #14 stays DRAFT; full CI and security gates must be checked on the resulting head, not assumed from these local results.
