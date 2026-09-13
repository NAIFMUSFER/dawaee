# Settings preference intent: proof and bounded extension

Branch: `audit/e2e-red-white-black-2026-09-09`; PR #14 stays DRAFT.
No production mutation, migration, merge, deployment, device registration,
notification send or paid provider call was performed in this pass.

## Exact baselines and concurrent work

The original AppProvider at `31f1d38453c671aaa36515a0a29c4568da45955b`
was checked against Git blob `f210f9ab2269b84dcdc0c6c9b5a7ef695b0c867a`
(15,512 bytes). Preserve inherited red tests `223ee6e9` and their TypeScript
transpilation repair `31f1d384`.

While local proofs ran, the branch advanced twice. The full source at `f77884f`
matched blob `f7a0292100ec07c585da64e18816ba71a5a32b26` (16,547 bytes),
and at `8629120fa9bc1edb75be5f300d2cbae3aebe46b5` matched blob
`5daadffeb9cae17270320cf9dccbfbc6ea7297a1` (17,278 bytes).
Their selected-self lookup, stale PATCH session/intent guards and GET-before-edit
fix are retained, including the latter's existing RTL/state handling. This
extension must be parented to `8629120`, not overwrite its history or claim
those concurrently authored fixes as new work.

The same permanent scenarios executed against all exact baselines:

| Suite | Original 31f1d384 | Concurrent f77884f | Concurrent 8629120 | Extended source |
| --- | --- | --- | --- | --- |
| Corrected callback scenarios | 2/9 pass | 8/9 pass | 9/9 pass | 9/9 pass |
| Whole provider + real scheduler | 4/13 pass | 7/13 pass | 8/13 pass | 13/13 pass |

Final source Git blob: `ea2f9d2a6358644765d9ae7d2da2514b2c834524`
(19,740 bytes). This is local proof, not a claim that CI already passed.

## Five remaining failures proved on the immediate parent

In `apps/mobile/src/state/app-store.tsx`:

- The settings lookup accepts an old API caregiver row with `isSelf:true` before
  the owned self row. It reaches the real scheduler with the wrong dose ID.
- `updatePreferences` changes React state but only refreshes `stateRef` during
  rendering. Enable then disable disclosure before a render: the second callback
  still reads false, schedules nothing, and leaves a NAMED native reminder while
  application state says disclosure is off.
- PATCH merges an entire row snapshot. An unrelated high-contrast response with
  an older `locale` undoes the optimistic language choice. The real API's PATCH
  returns snake_case columns including `locale` (profiles.ts:134-173), so this
  whole-provider scenario uses the actual raw-row field shape.
- Two locale PATCHes dispatch concurrently. In the controlled backend model,
  complete the newer write first and the old write last: the stored locale is
  wrong even when stale-response UI guards pass. This proves the admitted
  client ordering, not a measured production database incident.
- `loadMe` begun during a pending save can read the pre-save row and apply it
  after the save finishes. Its start generation equals the new local intent,
  so the concurrent GET-before-edit fix alone cannot detect this interleaving.

These are five failing behavioral scenarios, not five demonstrated production
incidents. Older baseline failures overlap the same defect families.

## Minimal runtime extension

Only AppProvider runtime is changed. Publish preference intent to the callback
ref immediately. Require both self and owner for device reminder eligibility.
Retain existing session/intent guards, but accept response values only for
submitted keys actually present in the response, not unrelated snapshot fields.
Serialize preference writes within a session and skip obsolete queued work before
API dispatch; a new session has a separate tail and failed writes release it.
Native privacy rebuilding stays immediate and never waits for the network queue.
Extend the existing GET preference-current condition with pending-at-start and
pending-at-completion checks. Keep valid user/profile/cache refreshes and the
existing positive uncontended GET/RTL behavior.

No API/RLS/schema, dependency, encryption, token-store, notification text/category,
deployment configuration, feature or security-gate change.

## Test quality and reproduction

The inherited callback fixture's final two cases originally assumed one
microtask was enough to adopt a cross-VM async promise, causing fixture failures
including a positive control. Replace that with a bounded timer-free wait for
the actual pending request. No assertion is removed. Restore registration of all
nine cases instead of the temporary `.slice(0,7)` exclusion. The locale scenario
supports either concurrent or serialized dispatch while retaining its latest
choice assertion and baseline red result. The two concurrently added standalone
`preference-loadme-race.test.ts` cases are preserved unchanged.

Thirteen NEW scenarios evaluate the complete actual AppProvider and real
notification scheduler, including actual provider signOut/signIn callbacks,
old queued saves versus a new account, new-account progress while an old request
is stalled, current failures, next-write recovery, signed-out language choice,
valid profile refreshes, and native reminder side effects. Host hooks deliberately
update refs only when render is called, not on every setState. Network, secure
storage and native OS APIs are synthetic. This is NOT React's renderer, real
PostgreSQL, full mount/bootstrap or a physical handset.

```sh
npx vitest run apps/mobile/test/preference-scope-races.test.ts \
  apps/mobile/test/preference-provider-lifecycle.test.ts \
  apps/mobile/test/preference-loadme-race.test.ts
```

Local VM execution used Node 22.16.0 and TypeScript 5.8.3. Container outbound DNS
was unavailable; no local complete install, PostgreSQL run, Expo export or full
typecheck is claimed. Complete CI/security must be verified on the final head.

## Remaining audit checklist / no release approval

Physical iOS/Android lifecycle, previews/actions/background/reboot, real push and
caregiver escalation/revocation receipts, full offline restart restoration,
bootstrap/sync cleanup races, owned-dependent editing UX, live OCR/object-provider
lifecycle, fresh public readiness/client-address verification remain open.
PATCH/GET preference casing and nullable quiet-hour persistence require separate
real API/database regression proof before server edits. Serial dispatch is not
exactly-once remote persistence across ambiguous transport failures or independent
devices; durable offline preference replay remains open. Green CI does not close
these E2E surfaces.
