# Auth transition intent and local privacy cleanup

Branch `audit/e2e-red-white-black-2026-09-09`, PR #14 remains DRAFT.
No production write, migration, notification send, device registration, merge or deployment.

## Exact-source proof and concurrent work

The initial baseline at `e8e67d6a2c2b8a6da563c198a3eaeff71a2c3c6d` matched Git blob `9720bf95a5beca3d64ba033a8d0e5a1c4c268589` (21,152 bytes). The eighteen unchanged controlled scenarios produced **15 failures / 3 passing controls**, before runtime editing.

During this work the branch advanced four commits to `ab307e4d09536ec735d47c85b2fbdfd2f2947b61`. Its exact AppProvider matched blob `a5a7862778cce0fafeaaf43593341ba13013be74` (21,212 bytes). That concurrent work already captures the outgoing cache owner and publishes the entire explicit logout to authCleanupInFlight. It is retained, not overwritten or claimed as new. Its three permanent app-provider-auth-transition-races cases remain unchanged and **3/3 pass** with this extension. Parent CI 228 / `34333795281` and Security 229 / `34333795224` were observed completed SUCCESS.

The SAME eighteen scenarios against that exact immediate parent give **12 failures / 6 passing controls**. Against this extension: **18/18 pass**, repeated in three independent local runs. Original failures overlap related race families; they are not fifteen independent vulnerabilities or production incidents.

## Remaining defects proved on the immediate parent

`apps/mobile/src/state/app-store.tsx:286-298`: signInWithTokens waits for cleanup before capturing authenticated intent and never rechecks its own completion. A later logout can be overtaken while the login waits. A stale /me or /profiles response can let the old signIn callback assign a new credentialVerifiedAt after logout or after a newer account's login. A pending credential write has the same caller-completion issue. The marker is intended for app-lock recovery; the tests prove wrong marker/state attribution, NOT a physical-device app-lock bypass.

`app-store.tsx:300-328`: duplicate logout calls start separate destructive sweeps. Identity, cache ownership and native reminder cancellation stay active while device lookup/remote cleanup waits. A getDeviceId rejection skips all remaining cleanup; a clearSession rejection skips cache/key destruction and UI reset. Existing credentialVerifiedAt is not cleared. While retiring credentials remain in memory for deregistration, fresh provider reads/syncs and preferences can still start using them (loadMe:166-177, syncNow:269-279, updatePreferences:334 onward).

The controlled sequences hold each boundary, exercise actual provider actions, and assert the resulting token-store calls, cancellation calls, cache/key ownership, visible identity, credential marker, and API dispatch identity. Delayed local purge and remote deregistration are passing controls on the immediate parent because the concurrent fix already covers them.

## Bounded extension

Capture sign-in generation before the first wait and recheck after cleanup, credential storage and profile loading. Only the still-current, signed-in attempt can set its credential marker. Keep storage failures reportable for the current attempt.

Coalesce explicit logout work, while every new logout still invalidates earlier login intent immediately. Capture the outgoing owner before waits; detach the visible identity/cache owner and credential marker immediately. Start native cancellation immediately. Retain remote deregistration/revocation on the retiring credentials, then clear credentials and complete local cache/key destruction even when device lookup or keychain deletion fails. A new login waits for the whole sweep, including preceding forced cleanup. A forced rejection during explicit logout must not replace that barrier or invalidate a newer login already waiting behind it. Block fresh provider profile/sync/PATCH dispatch while explicit logout is retiring credentials, while retaining signed-out optimistic language/accessibility behavior.

No API/RLS/schema, permission grant, cryptography, token-store implementation, dose queue/replay, notification text/category, dependency or deployment configuration changes. Existing latest-read and preference-intent fences remain intact. Already-started dose actions are not cancelled or discarded by this patch.

Runtime result: Git blob `755c5bbda93046a9846edbe14968bcd22c39c228` (22,346 bytes).

## Regression quality and verification limits

Eighteen NEW permanent scenarios run the complete checked-in TSX with controlled host hooks and auth/storage/network/native dependencies. Refs update on explicit render, not automatically on each setState. Some forced-rejection scenarios mount bootstrap to register the real handler, but the full renderer, HTTP backend, keychain and OS are not present. This is NOT browser/React-renderer/Postgres/native-device E2E. Synthetic identities and credentials only; no external requests.

Retained local suites: prior provider read/sync **14/14**, concurrent auth transition **3/3**, preference callback **9/9**, existing session source tripwires **2/2**. The extracted preference callback fixture required the new signOutInFlight ref; its missing-ref ReferenceError was reproduced before adding only `{ current: null }` to the fixture. All nine assertions and suite selection remain unchanged. The new standalone runner explicitly fails unresolved cases instead of exiting successfully without completing them.

```sh
node apps/mobile/test/auth-transition-lifecycle.cjs apps/mobile/src/state/app-store.tsx
npx vitest run apps/mobile/test/auth-transition-lifecycle.test.ts \
  apps/mobile/test/app-provider-auth-transition-races.test.ts \
  apps/mobile/test/app-provider-request-races.test.ts \
  apps/mobile/test/preference-scope-races.test.ts \
  apps/mobile/test/session-switch-race.test.ts
```

Local toolchain: Node 22.16.0, TypeScript 5.8.3. Container outbound DNS was unavailable, so full install/typechecking/PostgreSQL matrix/Expo export/security must be independently checked in CI on the resulting head. No passing CI on a parent substitutes for that check.

## Still OPEN / no release approval

The separate full-bootstrap offline probe STILL yields signedIn=true, ready=true, pendingSyncCount=3 but user=null, profiles=[] and activeProfile=null, including after this extension. It explicitly exits 1 and is not included among passing regression claims. Cache-owner restoration alone does not restore patient context. No profile or permission was fabricated to hide that failure. An account-bound encrypted bootstrap snapshot, profile-cache lifecycle, freshness and permission revocation need their own proof and remediation.

Other open surfaces: bootstrap/cleanup races outside these tested transitions; direct account switching before UI/context settlement; durable offline and cross-device preference behavior; current live public readiness; physical iOS/Android lock/privacy/background/cold-start/reboot and delivery/actions; real caregiver escalation/revocation receipts; live OCR/object-provider lifecycle. Underlying native/network/storage promises must eventually settle; a permanently hung dependency and failed remote revocation are not solved by a caller ordering fence. Keep PR DRAFT; this report does not close the full audit or approve a release.
