# OCR confirmation strength integrity — 2026-09-13

Base: `10247c3bb4df95167e8f4052158a2efa900b8e21` on PR #14.
No merge, production mutation, schema change, or release approval.

## Proven defect

`apps/mobile/app/medication/confirm.tsx` treated any non-empty strength input as `Number(...)`, but when the result was non-finite it wrote `strengthValue: null` and `strengthUnit: null` into the profile-bound prefill draft and continued to quick-create. Thus a user-confirmed value such as `abc` could be silently discarded rather than rejected. The downstream medication contract allows strength to be absent, so once the client converted the value to null the API could not distinguish an intentional omission from invalid input.

This is a client-intent integrity defect; it does not prove a server authorization bypass or a change to any real patient's data.

## Correction

Keep blank strength optional, but reject a supplied strength unless it is finite, positive, and no greater than the existing API contract maximum of 100000. Preserve valid numeric strength and its selected unit. Show the existing validation error on the strength field and keep the user on the confirmation screen for correction.

## Regression coverage

`apps/mobile/test/medication-confirm-strength-integrity.test.ts` covers non-numeric values, zero, negative values, the contract upper-bound overflow, a valid 500 mg value, and an intentionally blank strength. The test uses the checked-in screen harness and controlled process-local draft/navigation mocks; it does not contact production or a native OCR provider.

Exact-head CI and Security scan remain required before this audit branch can advance toward release.
