# Today: owned dependent is not a view-only caregiver

Audit branch only; PR #14 remains DRAFT. Immediate parent:
`8d337c821d759347068e60a655a95aea44a19455`. Preserve its newly added
`offline-cold-start-cache-owner.test.ts` unchanged, including the failing
cache-owner assertion. This independent Today fix does not solve offline boot.

## Proof before change

Exact `apps/mobile/app/(tabs)/today.tsx` source: 14,878 bytes, Git blob
`fee814f90df17ab6b156b2bcd33ad64b09d15c0e`. Lines 68-69 permit add/confirm
only for isSelf or explicit caregiver permissions. The API contract distinguishes
an owned dependent (`role:owner, isSelf:false, permissions:null`) from a
caregiver. `listAccessibleProfiles` derives role from ownership/linked identity
and returns null caregiver permissions for owners; caller-relative isSelf no
longer mislabels another patient as the viewer. Ownership is not equivalent to
self identity.

Run the twelve new cases against this unchanged source: **5 pass / 7 fail**.
An owned dependent has no Taken/Undo/Snooze/Skip callbacks and no empty-state add
button. The corresponding Taken online dispatch and offline queue cases fail
before they can act. Five controls pass: read-only caregiver action denial,
read-only caregiver add denial, explicitly granted caregiver confirmation,
explicitly granted caregiver addition, and own-self behavior.

These are seven failed scenarios of one UI authorization-contract defect, not
seven independent vulnerabilities or evidence of a production patient incident.

## Minimal fix and green result

Add `activeProfile.role === 'owner'` as an allowed UI capability in the existing
two Boolean predicates. Preserve their existing self/caregiver grant behavior.
No server or RLS permission is changed or granted by the client. Keep the
self-only native scheduling condition, request-scope fences, routes, action
payloads, copy and all other code unchanged. Final Today source: 14,946 bytes,
Git blob `66f6e092ed2c2489d0f056a7eb1a66beeb0f9ba9`.

The same twelve scenarios now pass **12/12**. In addition to visible callback
wiring, tests invoke Taken and verify the exact dependent dose ID, device/event
payload and scoped reload; a network failure queues that same dependent dose.
Viewing the owned dependent produces **zero local scheduler calls**. Granted
caregiver and self positive controls remain usable, and read-only caregiver
negative controls remain denied.

```sh
npx vitest run apps/mobile/test/today-owner-permissions.test.ts
```

The tests evaluate the complete actual Today route and request-scope hook with
the existing controlled host fixture. React host components, transport, encrypted
storage and native APIs are simulated. This is not a real React renderer,
physical-device test, actual offline durable replay, server authorization bypass
or new database integration proof. Existing API/RLS suites and the full CI/security
workflow must run on the new head. No test, dependency or gate is weakened.

## Still open

Offline cold-start cache owner, full user/profile restoration, bootstrap/sync and
logout cleanup interleavings, other owned-dependent screens, handset UX and real
push/escalation/OCR/object-provider lifecycle remain open. The immediate parent's
CI 217 / 34325601407 failed the newly added offline-owner case on PostgreSQL 16
and 17. PostgreSQL 17 job 102382079109 reports 1,344 passed / 1 failed, 88 files;
settings/provider cases passed. Security 218 / 34325601465 passed. These are
parent observations, not a claim of green CI for this not-yet-verified commit.

No production write, migration, merge, deployment, push registration/send or paid
provider call was performed. Main remains separate from this audit work.
