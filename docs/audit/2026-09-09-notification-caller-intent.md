# Reminder intent across asynchronous callers

Baseline: `e366e7fa3072459ad76d2424f90eb358968306da`. Preserve parent commits and the three existing `notification-cache-rebuild-race.test.ts` tests. This follows, rather than overwrites, the concurrently committed cache-versus-cancel fix.

## Evidence before runtime edits

The complete baseline notification source was checked against Git blob `b3dfb70074a3981afcbe29ae7d32573006231f47` (13,046 bytes); Today against `310165d7ad0eca3fd7f78995350234a81df74151` (14,580 bytes). The unchanged eleven new scenarios execute these actual modules together with controlled I/O.

1. `src/notifications/index.ts:326-335` only observes `scheduleGeneration` before the storage read. Two cached rebuilds therefore share a generation. Start named A, then newer private B, complete A first: A schedules named reminders and advances the generation; B is wrongly discarded. The opposite completion order was a passing control. Merely guarding against completed native mutations is not latest-user-intent ordering.
2. `app/(tabs)/today.tsx:82-121` carries the rendered privacy/voice settings through HTTP and cache-write awaits without a reminder-intent fence. Start an opted-in load, perform newer private rebuild or cancellation, then release its HTTP response or cache write. The old Today call enters the scheduler *after* the newer intent, replacing private reminders with named ones, or recreating one after cancellation. Four deterministic interleavings failed.

Local result before edits: **5 failed / 6 passed (11 cases)**. The tests operate at the caller/module boundary: Today and the scheduler are real source, but React/host rendering, HTTP, secure storage and native APIs are controlled. This is not a full AppProvider/logout/settings or physical-handset E2E test and not evidence of an observed production patient disclosure.

## Bounded fix

- A cached rebuild reserves its generation immediately, before its first await. Storage is intentionally NOT placed on the native mutation tail: cancellation must finish without waiting for a stalled cache read.
- Today captures reminder context before asynchronous clinical loading and checks it before scheduling. Valid clinical data/loading completion is retained; only obsolete reminder work is discarded. The existing profile/request fence still applies independently.
- The existing native schedule/cancel serial tail, notification wording/categories/permissions, API contracts, encryption and RLS remain unchanged.
- Existing fixtures expose their module loader and accept explicit dependency overrides so the new tests run the actual Today/scheduler interaction. Existing 42 screen and 11 native-mutation scenarios are unchanged; their default notification mock supplies the new capture API, while the new interaction suite uses the real API.

After edits: **11/11**, repeated three independent local runs. Existing profile scenarios: **42/42**. Existing native-mutation scenarios: **11/11**. An additional standalone cache-focused proof runs 8/8 after the fix; it overlaps these cases and is not counted as eight new permanent regressions. Full Vitest, TypeScript, exports and security gates must still be verified on the resulting SHA; these local results do not declare CI green in advance.

```sh
node apps/mobile/test/notification-caller-intent.cjs \
  apps/mobile/src/notifications/index.ts 'apps/mobile/app/(tabs)/today.tsx' \
  apps/mobile/src/hooks/useRequestScope.ts
npx vitest run apps/mobile/test/notification-caller-intent.test.ts \
  apps/mobile/test/notification-cache-rebuild-race.test.ts
```

## Still open / no production mutation

This does not settle late preference-save or bootstrap responses, which patient the settings caller selects, offline cold-start restoration, a permanently hung native module, physical lock-screen disclosure/actions, push registration/receipt, live caregiver-device escalation/revocation or OCR/object-provider E2E. Those require their own proof. Native cancellation is the tested boundary, not an assertion that every possible full logout interleaving is closed.

Only the audit branch is changed. PR #14 remains DRAFT. No production write, migration, merge, deployment, device registration, paid OCR call or notification send was made.
