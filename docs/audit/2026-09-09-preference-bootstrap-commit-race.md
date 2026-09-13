# Preference intent across offline-bootstrap persistence

Audit branch only; PR #14 remains DRAFT. No merge, deployment, production write, real notification or external OCR/provider call.

## Baseline and provenance

This is a separate bounded correction to the offline restoration already present on the shared branch, not an upload of the previously blocked local restoration candidate. The shared head was `008fb7ac7e1cdcabefae29e4fe9f9e4372b5268a` when the source was read and reproduced. While working, it advanced to `361993441e1988c47a301e6661134117d96eed33`, modifying only `apps/api/test/nullable-patch-semantics.test.ts`. That concurrent test change is preserved unchanged by building on its tree.

Exact local Git blob identities verified before runtime edits:
- `apps/mobile/src/state/app-store.tsx`: `602310718abd970995056fe2a87f390599d86a5c`, 27,353 bytes.
- `apps/mobile/test/preference-scope-races.cjs`: `2215eb790a8608a4acba4d47a8a5c396db925767`, 13,086 bytes.

## Red proof

In `app-store.tsx:223-250`, loadMe calculates preferencesAreCurrent before awaiting persistOfflineBootstrap at line 233, then uses that earlier boolean to commit server preferences and native text direction. The session/profile-load fence remains true if the user changes only a preference during the storage wait.

Sequence: receive the old /me and /profiles responses -> hold the snapshot write -> user changes privacy, App Lock or locale -> optionally complete that newer PATCH -> release the old snapshot write. The old loadMe overwrites the newer choice even when the PATCH has already succeeded and its pending counter is zero.

The SAME six regression cases run against the exact unmodified source yield **4 failures / 2 passing controls, exit 1**. They reproduce disclosure opt-out becoming true again, App Lock enablement becoming false, the locale reverting, and pending optimistic privacy being undone. The positive controls verify current server preferences still commit and the existing account-switch fence still works.

## Bounded fix

After snapshot persistence and the existing current-request check, re-evaluate both the preference generation and pending-write boundary before committing preferences or native direction. Keep the valid profile/user update instead of discarding the entire response. No changes to snapshot encryption, persistence ordering, role filtering, queue/replay, token storage, API/RLS, native notification wording/scheduling, dependencies or release settings.

Final runtime blob: `d35690eb8a6b38e202896bbfa13963d8aa967e84`, 27,814 bytes. Runtime diff: 9 added / 3 removed lines.

## Tests and limits

Added `preference-bootstrap-commit-race.test.ts` with six permanent Vitest cases. The existing callback fixture gained a controllable snapshot-write promise and a native-direction observation list; its existing nine scenario bodies remain unchanged.

Local result: **6/6 pass**, repeated in three independent runs; retained preference scenarios **9/9 pass**. Node 22.16.0 / TypeScript 5.8.3. Project dependencies and Vitest were unavailable in the local container. The local runner transpiles the checked-in test and supplies only registration/assertion adapters; the actual extracted loadMe/updatePreferences source executes in the existing VM fixture. These local results are NOT a Vitest-engine, real React renderer, database, keychain, OS or handset E2E run. No physical lock bypass or observed production disclosure is claimed.

At the repository root with dependencies installed:

```sh
npx vitest run apps/mobile/test/preference-bootstrap-commit-race.test.ts apps/mobile/test/preference-scope-races.test.ts
```

To reproduce red, use the same new test and instrumented fixture with the exact baseline AppProvider source. The evidence package records both source blobs and unchanged six-case results. Full CI/security must be checked on the resulting branch head separately.

## Other live audit findings are not hidden

The completed baseline CI run 263 (`34370000831`, PostgreSQL16 job `102528905200`) reports **1,447 passing / 2 failing tests in 102 files**. Its only failures are the separately added API nullable-PATCH cases: medication optional fields retain their previous values after an explicit null PATCH, and a schedule endDate remains `2026-10-15` after null. Security run 264 (`34370000779`) passed. Those results belong to the baseline, not this correction. The concurrent parent adds further API assertions; none are removed, weakened or fixed speculatively here.

Existing shared-branch cold-start/lock/storage suites passed in that baseline run, but no full new-device or clinical end-to-end acceptance is inferred. Current public readiness, physical-device offline/reboot/notification delivery, multi-profile schedule caching, expiry/date rollover, durable offline preference reconciliation, caregiver receipts and live OCR/object-provider lifecycle remain separate checklist items. This change does not make the earlier local candidate's different multi-profile/freshness features part of the shared implementation. Keep PR DRAFT until all relevant release evidence is complete.
