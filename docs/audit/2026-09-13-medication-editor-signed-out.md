# Signed-out direct medication editor — 2026-09-13

Base: `087f2320e8a592543ad5efcab47700ec6d2d9a26`, PR #14.
No merge, production mutation, or release approval.

## Evidence

The confirmed Render workspace is `My Workspace`; the inspected service is only `dawaee-audit-preview` (`srv-daipkbuk1f9s73952trg`). Deploy `dep-daj7mm7qj5pc73avkvsg` was LIVE on the exact base SHA. Base CI #829 and Security #830 completed SUCCESS.

A live browser registered one synthetic account successfully, then opened the fixed `/medication/edit` URL with a full document navigation. The browser session intentionally does not survive reload (`apps/mobile/src/api/token-store.ts`, `secureStore`, `readSession`, and `writeSession`): no persistence change is needed or made.

The resulting editor was nonetheless visible and accepted synthetic input into name, manufacturer, barcode, and notes. Save produced neither a medication request nor a visible error. Read-only inspection of app context flags showed `ready=true`, `signedIn=false`, no user and no active profile; no credential or clinical identifier was printed. Render request logs corroborated registration/bootstrap and the document request, without a subsequent medication POST in the inspected window.

At the base, `apps/mobile/app/medication/edit.tsx:93-105` always renders `EditMedicationProfileScreen`, while `save()` returns immediately on `!activeProfile`. This is an unusable signed-out form, **not** evidence of an authorization/RLS bypass or saved patient data loss.

## Minimal fix

Return Expo Router's `Redirect` to the fixed `/sign-in` path when no user exists, before rendering the editor or resolving a private medication intent. Preserve the deliberate memory-only web session, all authenticated create/edit behavior, metadata retention, API authorization, profile ownership and URL-privacy policies. No shared test harness or existing test was changed.

## Executed regression

Selected source files were downloaded at the pinned public commit and Git-blob verified in an isolated connector execution directory:

- original editor: `48188bc188b461ec5c4b45a881d3c78f863c02d4`
- unchanged harness: `1d5bc90806080adb8a3a2108d0ba9acf055edefc`
- unchanged request hook: `88a0f03fc2dca8648e57a311ec3a7b5bd9af2b99`
- patched editor: `c4422986a20b6d05d8055864541a268ce065a1b2`

Node v24.20.0 executed the actual editor through the existing controlled-I/O harness, with isolated TypeScript 5.9.3 matching the repository lockfile. The new four-case suite yielded **2 PASS / 2 FAIL before** (missing sign-in redirect assertions) and **4 PASS / 0 FAIL after**. Cases cover signed-out direct entry, immediate logout visibility with a late response, authenticated create, and authenticated edit metadata. Existing metadata round-trip suite still passes **5/5**.

```sh
node --test --test-reporter=tap apps/mobile/test/medication-editor-signed-out.cjs
```

The new Vitest wrapper includes this bounded shell-free command in the normal suite. This is not a full local workspace run, native-device E2E, proof of successful live metadata round-trip, or a provider-delivery receipt. New-head GitHub gates and live preview redirect/metadata verification remain required. The local ChatGPT container could not resolve GitHub; the explicitly connected remote browser environment was used instead, without changing repository dependencies.
