# Medication edit load safety — 2026-09-13

Base inspected: `df75e8453393980974ce03a5c7f104755ee85441`, PR #14. No merge, production mutation, or release approval.

## Proven finding

In `apps/mobile/app/medication/edit.tsx`, edit mode derives `isEdit` from the private-route medication id and starts with an empty draft. The load effect catches a failed GET, records an error, and always clears `loading`. It does not record that the existing medication was successfully hydrated. The render then exposes the normal editable form and Save. `save()` still sees `isEdit && medicationId` and can PATCH `/v1/medications/<id>` using whatever values are now in that unhydrated draft.

This proves an unsafe client request path after a failed edit load. It does **not** prove an authorization/RLS bypass, a successful real-patient mutation, or loss of server-side high-risk confirmation.

## Minimal correction

Track successful edit hydration separately from loading. An existing-medication editor is allowed to render/save only after the GET has produced a medication and populated the draft. Network or other load failures remain visible in a fail-closed error/back state. Mutation errors after a successful hydration do not clear that state, so retry and high-risk confirmation behavior remain unchanged. Explicit create mode remains unchanged.

## Regression coverage

`apps/mobile/test/medication-edit-load-safety.cjs` executes the actual TSX editor and unchanged request-scope hook with the existing controlled-I/O harness. It covers:

- network failure while loading an existing medication: no fields, no Save, no write;
- non-network load failure: same fail-closed behavior;
- successful hydration: loaded metadata survives and an intentional edit PATCHes the selected medication;
- explicit create mode: no medication GET and normal POST/navigation behavior.

The Vitest wrapper runs the same bounded shell-free Node test in the repository collection. Full CI/security on the final exact HEAD remains required; this is not browser/native E2E or a provider receipt.
