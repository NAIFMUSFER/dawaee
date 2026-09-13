# Escalation editor patient-stage integrity — 2026-09-13

## Baseline

PR #14, branch `audit/e2e-red-white-black-2026-09-09`. The direct API contract
was hardened in `0c14e1225f788b97dbdbb3e4bd17bcf7383b8240` so enabled ladders must
start with the patient. This follow-up addresses the independent mobile editor
surface rather than relying on server rejection for states the UI itself can
compose.

## Proven UI paths

The advanced editor says stage 0 is the patient's own reminder, and it already
made removal of stage 0 unavailable. However two owner controls could still
replace that stage with a caregiver target:

1. stage 0 exposed every target button and `changeTarget(0, caregiver)` changed
   the payload directly;
2. reordering swaps target/channel payloads while leaving timestamps fixed, so
   moving stage 0 down or stage 1 up could place a caregiver in stage 0.

The save path checked non-empty stages/channels, ordering and quiet-hour syntax,
but did not independently verify that stage 0 still targeted the patient. The
core worker consumes the configured stage target as-is; therefore this was not a
cosmetic editor issue.

## Correction

- non-patient target choices are disabled for stage 0 and the handler rejects
  direct callback invocation;
- the stage-0/1 reorder boundary is locked in both UI state and handler logic;
- the stage-0 remove handler now also guards the invariant, matching its existing
  disabled button;
- save fails closed unless stage 0 targets the patient, including legacy invalid
  stored policies;
- the Save button reflects that invalid state;
- a legacy caregiver-first policy can still be repaired by selecting Patient for
  stage 0;
- editing and reordering stages after the protected boundary remain available.

## Regression coverage

`escalation-patient-stage-integrity.cjs` executes the actual TSX through the
existing controlled-I/O screen harness. Eight cases cover target replacement,
both reorder directions at the protected boundary, removal callback defense,
legacy invalid-state save blocking and repair, later-stage editing, and later
stage reordering. A Vitest wrapper adds the exact 8/8 expectation to CI.

These tests are authoritative when the exact-head CI succeeds. They are not a
native renderer or physical-device E2E claim.

## Release boundary

No API, database, worker, authorization, provider or deployment configuration is
changed by this follow-up. PR remains Draft; no production deployment or merge is
authorized. Production request-log cutover verification, physical iOS/Android
acceptance, provider receipts, OCR/object-storage and offline/multi-device
acceptance remain open.
