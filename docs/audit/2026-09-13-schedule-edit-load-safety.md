# Schedule edit load safety — 2026-09-13

Base: `dd29ebe4d2b5593a67a04b97352f5a99f9ad067d`, PR #14.
No merge, production change, live patient mutation, or release approval.

## Proven before changing the screen

`apps/mobile/app/medication/schedule.tsx:107` initialized the editable schedule identity from the private route selection before any GET succeeded. At lines 146-161, a rejected GET or a successful response without the selected schedule cleared loading without hydrating the form. Default timing/quantity/unit then remained visible and savable.

At lines 280-322, Save could PATCH those defaults using the unverified selected ID. With an edit intent lacking an explicit schedule ID and an unsuccessful/empty load, it could instead POST a new schedule. The API's authorization and high-risk confirmation remain independent server checks: this finding proves an incorrect client request, not a bypass of those checks or an observed change to a real patient's schedule.

The exact screen, unchanged request hook and unchanged controlled-I/O harness were Git-blob verified before execution:

- schedule screen: `a75a04593f5c42293b7959af770d45f1c634ab32`
- request hook: `88a0f03fc2dca8648e57a311ec3a7b5bd9af2b99`
- harness: `1d5bc90806080adb8a3a2108d0ba9acf055edefc`

## Limited correction

The route ID remains the fetch target, but the editable `scheduleId` starts null and is set only after hydration completes. Both form rendering and Save require this hydrated identity in edit mode. Network/API load errors remain visible; missing schedules show not-found with a safe Back action instead of a default form. Explicit creation, active-schedule selection, valid editing, private navigation, profile isolation, mutation retry and high-risk confirmation are preserved. No server, schema, clinical rule, dependency or shared harness is changed.

## Executed regressions

```sh
node --test --test-reporter=tap apps/mobile/test/schedule-edit-load-safety.cjs
```

Node v22.16.0 and the preinstalled TypeScript 5.8.3 executed the actual TSX/hook with controlled I/O. Final test harness setup on the original screen: **7 PASS / 5 FAIL**. On the patched screen: **12 PASS / 0 FAIL**, no skipped/cancelled cases. Five red cases emitted an unintended mock PATCH/POST on the original screen; no network write was performed. Seven controls exercise successful edit/create, active-schedule selection, absent intent, profile switching, explicit high-risk confirmation, and retry after a mutation error. The new Vitest wrapper runs the same bounded, shell-free Node command in the repository's normal test collection.

These are deterministic screen-boundary tests, not a full local workspace build, native-device test, live browser journey, or provider receipt. Full CI/security must complete on the new exact HEAD. The local container cannot resolve GitHub for a complete clone; selected connector-fetched files were hash-verified. A fresh read-only Firecrawl verification returned Insufficient credits, so no browser pass is claimed.
