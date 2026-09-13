# Offline Today: prior-day hero starvation and duplicate cached rows

Baseline: `ef496fd93d96597219b9edca354f95ce016f6a96`, audit/e2e-red-white-black-2026-09-09. PR #14 remains DRAFT; no merge, deployment, production write or notification send.

## Evidence before runtime changes

The exact Today source matched Git blob `66f6e092ed2c2489d0f056a7eb1a66beeb0f9ba9` (14,946 bytes). The existing screen harness matched `72c618dc914fe0c6639edd8f637bdbf7c5852837`; useRequestScope matched `88a0f03fc2dca8648e57a311ec3a7b5bd9af2b99`. These exact sources are used, not a simplified replacement of the product's selection logic.

`today.tsx:130-150` maps the entire cached window and chooses its first actionable status without filtering the current local date or deduplicating occurrence ids. At lines 269 onward the UI then suppresses a hero whose date differs from Today, while the ordinary dose cards have no Taken/Snooze/Skip callbacks. A still-upcoming prior-day cached dose therefore suppresses the current-day action surface. The cache itself is built from overlapping today + prefetch arrays at lines 95-105, so one occurrence can also appear twice in the offline daily list.

Controlled source execution: fail /v1/today with NetworkError, return an earlier day's real-shaped cached window containing yesterday and today, complete the load, inspect actual rendered screen props. At Riyadh midnight and at east/west UTC date boundaries the prior-day dose hides today's hero. Unsorted cached windows can similarly pick a later or future-day entry first. Duplicated ids produce two daily list rows for one occurrence.

The SAME ten scenarios gave **7 failures / 3 passing controls before editing**, then **10/10 passes after**, repeated three independent local runs. The current-dose action scenario runs at the actual synthetic dose due instant; it invokes Today.onTaken, verifies the correct occurrence POST, injects network failure and observes the same occurrence handed to enqueue. It does not prove durable encrypted persistence or server stock idempotency because those dependencies are mocked.

## Bounded fix

Normalize cached view occurrences by id, sort by scheduled instant, and exclude earlier patient-local calendar dates from the next-dose search. Do not rewrite cached/server dose statuses, infer missed doses, delete queue history, change early-action rules, migrate storage, add patient permissions or change notification scheduling. The only runtime edit is 7 added / 2 removed lines in the cache hydration branch. Existing profile/session and reminder-intent fences remain unchanged.

This is independent of the previously tool-blocked reference-PATCH and bootstrap candidates. Their payloads are not retried or routed through this change. Subsequent concurrent reference/materializer work is retained from the immediate parent, not claimed as newly implemented here.

## Reproduction and limits

```sh
node apps/mobile/test/offline-today-rollover.cjs 'apps/mobile/app/(tabs)/today.tsx'
npx vitest run apps/mobile/test/offline-today-rollover.test.ts apps/mobile/test/profile-screen-races.test.ts
```

Run the same standalone runner with the baseline Today file and optional second argument for the checked-in request-hook path to reproduce red. Local Node22.16.0 + TypeScript5.8.3; no local PostgreSQL or dependency installation was available. Full CI/typecheck/security results must be checked on the resulting head and are NOT predeclared green here.

The harness simulates React hook/keyed-root lifetime, presentation components, network, storage and native notification APIs. This is actual-source screen-boundary regression, NOT a native/React-renderer/browser end-to-end test. It does not exercise physical reboot, lock-screen delivery, real encryption, a full stored-session bootstrap or server authorization. Controls retain current-day behavior, resolved statuses, and no current-day action for a future-only cache.

Still open separately: multiple profiles sharing the one schedule-cache slot; clinical fields absent from cached DoseView (including detail navigation/timezone); advancing an already-mounted screen at midnight without a reload; snooze/offline status reconciliation; durable offline preference lifecycle; real handset notification/privacy/caregiver delivery, OCR and provider acceptance. None is closed by this bounded correction. Keep PR DRAFT until remaining audit and release evidence is complete.
