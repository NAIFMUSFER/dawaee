# Emergency QR load and disclosure safety — 2026-09-13

## Baseline and scope

PR #14, branch `audit/e2e-red-white-black-2026-09-09`, baseline
`7be0ecb45bbe6aeebf8f12474dccf9d518b60095`. GitHub directly confirmed CI #850
and Security #851 SUCCESS on that exact baseline before this change.

Only `apps/mobile/app/settings/emergency-qr.tsx` runtime code changes. No API,
schema, authorization, provider, token transport, dependencies, workflow,
deployment configuration or production data changes.

## Evidence before the fix

The actual QR screen renders `card?.qrEnabled ?? false` as disabled and offers
Enable both while its initial GET is pending and after it fails. Controlled-I/O
screen tests invoke that exposed action and observe a POST to
`/v1/emergency/qr/enable`. The existing server route uses that same operation for
creation and rotation, replacing the stored token hash on conflict. Thus an
unknown existing QR can be presented as first-time enable without the rotation
warning. No production mutation was used to prove this.

The card API also returns `includeConditions`, and the editor already controls
it, but the QR screen omits this fourth disclosure flag from its summary. The
new screen assertions fail for both true and false conditions-disclosure values.

## Regression execution

The unchanged checked-in screen harness and request hook execute the actual TSX
with synthetic profiles and deferred network responses. Source reconstruction
was verified using Git blob hashes before testing:

- Baseline QR screen: `feec8b4c0ba989f9860e06005f271c59b927d204`.
- Existing harness: `1d5bc90806080adb8a3a2108d0ba9acf055edefc`.
- Existing request hook: `88a0f03fc2dca8648e57a311ec3a7b5bd9af2b99`.

```sh
node --test --test-reporter=tap apps/mobile/test/emergency-qr-load-safety.cjs
```

Local BEFORE: **15 tests, 5 PASS / 10 FAIL**. Local AFTER: **15 PASS / 0 FAIL**.
Failures before the patch were behavioral assertions, not missing dependencies.
The Vitest wrapper adds the same suite to existing CI and checks exact counts.
Local execution used available TypeScript through `TYPESCRIPT_PATH`; it is not a
claim of full repository typecheck/integration, browser or physical-device E2E.

Coverage includes pending GET; network/API/unexpected errors; explicit retry;
legitimate `card:null`; enabled/disabled controls and rotation warnings; both
conditions-disclosure states; committed enable/disable followed by failed refresh
without mutation replay; retaining and copying a successfully issued one-time
link during refresh; no active profile; first-frame profile isolation and late
old-profile read completion.

## Correction and preserved behavior

An explicit successful-load flag distinguishes a real empty card from unknown
state. Every read invalidates that flag; status, disclosure details and write
controls require a completed successful read. Mutation handlers also check load
readiness and busy state. Read failures have Retry, including API/general errors;
retry performs only a GET, never repeats an already committed mutation.

A link successfully returned by an enable/rotate response remains available while
its follow-up GET is pending or fails, preserving the one-time delivery contract.
A successful disable still removes it immediately. Profile-keyed lifetime remains
unchanged. The fourth disclosure flag is shown without changing any disclosure
choice or publishing any additional information.

## Release boundary

Recheck CI/security on the resulting candidate SHA; baseline success is not
inherited. Render preview identity remains NOT_VERIFIED in this run: the
connector requires explicit workspace confirmation and no workspace was selected.
PR stays Draft. No merge or production deployment. Production privacy cutover
and post-cutover Render request-log evidence, physical iOS/Android acceptance,
provider receipts, OCR/object-storage and offline/multi-device acceptance remain
open and are not closed by these controlled-I/O tests.
