# Provider read/sync request ownership

Baseline: `ea03b2ddabba45864484fe5ebf0c0036b844eb51` on `audit/e2e-red-white-black-2026-09-09`. The complete baseline AppProvider was verified against Git blob `02b9cdcbb57f0c62261dc31b2d9f191157536d83` (20,383 bytes). Parent CI 222 / 34328410337 and Security 223 / 34328410327 completed successfully before this change. Preserve the thirteen intervening commits since the earlier 4aa81b6 checkpoint, including settings intent, owned-profile controls and local cache-owner restoration.

## Evidence before runtime edits

`apps/mobile/src/state/app-store.tsx:167-212`: loadMe fences session changes only after both GETs. Two refreshes in one session share the same fence. Hold the older /profiles response, complete a newer refresh that removes a relationship or confirm_dose permission, then release the older response: the removed profile/permission returns to application state. An older /me privacy/locale snapshot can similarly replace a newer GET result. If the first GET returns after switching accounts, the old continuation also dispatches /profiles using the next account before its final session check.

`app-store.tsx:257-264`: syncNow waits for device ID, queue flush and queue size, then checks only mounted. A stalled A operation can resume after actual provider signOut/signIn callbacks establish B, flush B's queue after its old device lookup, or put A's offline/count result on B. Two same-account sync results can likewise finish in reverse order and restore an obsolete offline indicator.

The unchanged fourteen scenarios execute the COMPLETE checked-in AppProvider, not a hand-written copy of loadMe/syncNow. On the exact baseline: **10 failed / 4 passed**. After the bounded change: **14/14 passed**, repeated three independent local runs. Every final red failure is an assertion about behavior, not a missing dependency, unresolved promise or timeout. The standalone runner explicitly rejects unresolved scenarios rather than exiting successfully with an incomplete count.

These are two related defect families and fourteen regression scenarios, not ten proven production incidents. Responses, host hooks and queue/session boundaries are controlled. Tests use synthetic accounts and provider callbacks for session transitions, but do NOT exercise React's renderer, mount/bootstrap effects, real HTTP/Postgres/RLS, secure-storage internals, native notifications or handsets. No server authorization bypass or observed production patient disclosure is claimed.

## Bounded remediation

- Give profile loads and sync operations independent latest-started request generations in addition to the existing authenticated-session generation.
- Check before work and after each awaited boundary, so obsolete work cannot initiate a later read/flush or commit state/cache-owner/RTL side effects.
- Preserve the existing preference-intent/pending-save fences, self-profile selection, stored-session owner resolver and all valid refresh/sync behavior.
- Do not cancel or discard dose actions already handed to flushQueue; its existing account-bound queue/replay mechanism is unchanged. Only obsolete caller continuations are fenced.
- One extracted-callback test fixture now supplies the newly required profileLoadGeneration ref. Before adapting it, executing the new loadMe with the old fixture gave ReferenceError: profileLoadGeneration is not defined. After providing the real mutable ref shape, all nine existing scenarios pass with their assertions unchanged. No negative test, suite selection or security threshold was weakened.

Runtime source after change: Git blob `9720bf95a5beca3d64ba033a8d0e5a1c4c268589` (21,152 bytes).

```sh
node apps/mobile/test/app-provider-request-races.cjs apps/mobile/src/state/app-store.tsx
npx vitest run apps/mobile/test/app-provider-request-races.test.ts \
  apps/mobile/test/preference-scope-races.test.ts \
  apps/mobile/test/preference-loadme-race.test.ts \
  apps/mobile/test/preference-provider-lifecycle.test.ts
```

Full CI/security must be verified on the resulting head, separately from the local results above. Container outbound DNS was unavailable; no complete local dependency install, database matrix, export or typecheck is claimed.

## Explicit remaining checklist

Full bootstrap/cold-start profile restoration and cleanup races; sign-in credential-completion and overlapping sign-out transitions; cross-device preference ordering; native handset notification/privacy/actions and caregiver escalation/revocation receipts; live OCR/object-provider lifecycle; current public readiness and external-client-address evidence remain open. A request-generation fence does not remotely erase an offline cache after permission revocation and does not prove device delivery. No database migration/policy, API contract, dependency, deployment configuration, production data, device registration or notification send was changed. Keep PR #14 DRAFT; this document does not approve merge/deployment or close the comprehensive E2E audit.
