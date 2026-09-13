# Clinical browser-route URL privacy — 2026-09-13

## Proven finding

The fixed-path API transport does not by itself keep identifiers out of the
browser's own route. Current mobile/web source still generated medication and
caregiver destinations containing stable resource ids, including:

- `/medication/<medicationId>`;
- `/medication/edit?...&id=<medicationId>`;
- `/medication/schedule?medicationId=...&scheduleId=...`;
- `/medication/stock?medicationId=...`;
- `/caregiver/<relationshipId>`; and
- `/caregiver/dashboard?profileId=...` after accepting an invitation.

Expo Router updates are client-side during an uninterrupted web session, but
the identifier remains in browser history. A reload or direct open then sends
that full path/query to the hosting edge before application redaction can run.
This is the same upstream boundary already established by the Render
request-log proof; it is not a claim that a production reload of every route
was observed.

Before runtime changes, the AST-based regression in
`apps/mobile/test/clinical-route-url-privacy.test.ts` failed all nine source
controls that then generated these identifier-bearing destinations.

## Remediation

Current navigation now uses fixed public destinations:

- `/medication/detail`, `/medication/edit`, `/medication/schedule`, and
  `/medication/stock`;
- `/caregiver/detail` and `/caregiver/dashboard`.

The selected resource is handed off in process-local memory by
`private-navigation.ts`. Each slot expires after 15 minutes and requires an
exact account id plus patient-profile id match. It does not use AsyncStorage,
SecureStore, localStorage, sessionStorage, or URL state. A reload/process death
therefore intentionally loses the selection and fails closed instead of
persisting a health-linked identifier in a public location.

The old dynamic detail entries remain as compatibility scrubbers. When an
already-issued route is opened, the current process captures its id in the
same scoped slot and replaces the browser route with the fixed destination.
This cannot erase the first request that already reached the host; it prevents
the current bundle from generating or retaining that legacy URL afterward.

Invitation acceptance now selects the returned patient through application
state before opening the fixed caregiver dashboard. The dashboard no longer
needs or consumes `profileId` URL state.

## Verification

- Red reproduction: 1 file / 9 failing source controls before the runtime fix.
- Fixed privacy and handoff set: 4 files / 31 tests passed.
- Full mobile suite: 87 files / 627 tests passed.
- Mobile strict TypeScript: passed.
- Repository ESLint: passed.

The profile/request/mutation race suites remain enabled. Their harness gained
only the new route-intent boundary mock required by the production imports;
selected tests also exercise the fixed-route consumer path. No authorization,
API transport, database policy, or server logging rule was weakened.

## Release boundary

This branch evidence does not close the Render production blocker. An
already-open old web bundle can still emit legacy identifier-bearing API URLs,
and the first request for an old dynamic browser route is already upstream by
the time a new bundle can scrub it. Closure still requires the approved
client-first production cutover and a post-cutover inspection of Render's own
request logs. No merge or production deployment was performed here.
