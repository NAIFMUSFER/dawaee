# Offline bootstrap plaintext boundary — OPEN, red regression only

The shared branch now contains an independent offline bootstrap implementation. This review does not replace it with the previously blocked local candidate or retry that candidate's blocked harness upload.

## Exact-source evidence

At 58581f734dbefd4d887fcec8aff002fbae970866 (retained by immediate parent f251713435b435f9cbd1078da98c9991f557d7d9):
- apps/mobile/src/storage/offline-bootstrap.ts, blob fded58abc43df602b5d677717bad5b9efe722e86, registers a new slot at line 15 and uses generic readSlot at lines 147-151.
- apps/mobile/src/storage/secure-cache.ts, blob 5dc17f01203c309adfbb3614ddb9479a031df56e, treats absent/failed ciphertext reads at lines 77-78 as a reason to consult the unscoped plaintext predecessor at lines 102-150.

Those two files were reconstructed locally from the connector response and independently verified against Git blob hashes before editing. A synthetic snapshot with a matching account ID and appLockEnabled=false, placed ONLY in the new plaintext key, was accepted and promoted to ciphertext. No valid encrypted bootstrap or server-verified snapshot was necessary. Variants also accepted plaintext after a ciphertext read error, after a legitimate encrypted copy was removed, and when plaintext removal failed.

The existing offline-bootstrap.test.ts mocks readSlot/writeSlot entirely; its passing parser cases do not test the actual migration boundary.

## Local results and proposed boundary

A portable actual-source storage probe has nine scenarios: four failing/ five passing before the proposed boundary; nine passing after. It controls disk/key lifecycle and adapts AES with Node crypto, so this is boundary reproduction, not verification of the production cipher library or a physical-device AppLockGate bypass. Existing real legacy dose-queue migration and migration-write-failure preservation are positive controls.

The bounded candidate makes plaintext migration opt-out per slot and marks the new bootstrap slot as encrypted-only. No legacy unsent-dose queue behavior, API, database, key format, or existing ciphertext changes are proposed.

## Upload blocker / exact scope of this commit

The tool accepted the NEW standard Vitest storage-boundary test blob, then blocked uploading the proposed secure-cache runtime file because it could not determine safety status. The runtime upload was NOT retried through another method, another path, an encoded representation, or a different connector.

THIS COMMIT IS DELIBERATELY TEST-ONLY RED EVIDENCE plus this report. It does not include the blocked runtime file or an alternate implementation. The nine new permanent Vitest cases use actual offline-bootstrap.ts, secure-cache.ts and production crypto.ts with test disk/key/Expo adapters. Their actual CI result must be observed separately, not inferred from the local Node-cipher probe.

Run at repository root after locked dependencies are installed:

    npx vitest run apps/mobile/test/offline-bootstrap-storage-boundary.test.ts

No merge, deploy, production write, patient-data read, device registration or notification send was performed. PR #14 must remain DRAFT. The plaintext boundary remains OPEN until an authorized runtime fix passes these regressions and the full latest-head gates. The previously claimed 26-case local-candidate success must not be attributed to this distinct shared-branch implementation.
