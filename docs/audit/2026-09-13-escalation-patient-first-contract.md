# Escalation patient-first contract — 2026-09-13

## Baseline

PR #14, branch `audit/e2e-red-white-black-2026-09-09`, baseline HEAD
`dd3a4a5765e985de89e50dbffe7a088d6fea815b`. CI #851 and Security #852 were
SUCCESS on this exact baseline, and Render audit preview deploy
`dep-dajb9u8u01pc738v1ev0` was LIVE on the same SHA before this change.

## Proven finding

The mobile escalation screen documents stage zero as the patient's own reminder
and says that stage is never removed. However, advanced controls permit changing
the target of stage zero, and reordering can swap a caregiver payload into stage
zero. The save guard checks only non-empty channels, increasing times and quiet
hours; it does not enforce a patient first stage.

The shared `updateEscalationPolicySchema` likewise previously checked stage shape
and strictly increasing `afterMinutes` only. Therefore a direct API client could
submit an enabled empty ladder or an enabled ladder whose first stage targets a
caregiver. The caregiver route persists the parsed stages unchanged. This is a
contract-level safety defect because the same mobile screen explicitly states
that the worker uses stage zero for the patient's reminder.

## Bounded correction

A shared wrapper now strengthens the exported `updateEscalationPolicySchema`: an
**enabled** policy must contain at least one stage and stage zero must target
`patient`. Disabled policies retain their prior shape, including an empty ladder,
so this does not silently redefine historical disabled-policy semantics. The
existing increasing-time refinement remains in force.

The root shared package explicitly exports the strengthened schema, so existing
API imports from `@dawaee/shared` receive the guard without changing route,
database, authorization or worker code.

## Regression coverage

`packages/shared/test/escalation-patient-first-contract.test.ts` covers:

- enabled patient-first ladder accepted;
- enabled caregiver-first ladder rejected at `stages.0.target`;
- enabled empty ladder rejected;
- disabled empty ladder preserved;
- underlying non-increasing-stage rejection preserved.

This closes the server/shared-contract persistence path. The existing mobile
advanced editor can still construct an invalid draft and may receive validation
feedback from the API; locking its first-stage editing controls remains a UX
hardening opportunity, not a persistence bypass after this contract guard.

## Release boundary

Re-run CI, Security and Render preview identity on the resulting candidate SHA.
No merge or production deployment is authorized by this change. Production
request-log privacy cutover, physical iOS/Android acceptance, provider receipts,
OCR/object-storage and offline/multi-device acceptance remain open.
