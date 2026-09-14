# Caregiver push release checklist

Status: **NOT RELEASE-VERIFIED**. PR #25 carries the caregiver work and the release controls from PRs #22/#24. No production deployment or PR merge is authorized by this checklist.

## Approved product contract

The channel is an app push notification, not SMS. A patient reminder precedes caregiver escalation according to the configured policy. A missing server confirmation means **not confirmed**, not proof that the patient did not take a medication. Offline confirmations may not have synchronized yet.

The provider-bound caregiver envelope is deliberately generic, even when detailed medication reminders are enabled for the patient's own device:

- Arabic title: `دوائي — تنبيه متابعة`
- Arabic body: `لديك تنبيه يحتاج إلى متابعتك. افتح دوائي لعرض التفاصيل.`
- English title: `Dawaee — Follow-up alert`
- English body: `You have a follow-up alert. Open Dawaee to view the details.`
- Data allowlist: `deliveryId`, `kind`. Never include patient/medicine names, dose IDs, clinical timing or Taken/Snooze/Skip actions on a caregiver push.

The detailed outbox record stays on the server. A delivery ID is a lookup reference, never an authorization credential. The mobile listener passes only `deliveryId` and `kind` into one process-local account-bound slot and opens `/caregiver/notification` with no URL identifiers. The authenticated resolver returns only the currently authorized patient identity and kind; it never returns historical medication content.

The landing waits for both the app lock and the caregiver-area lock, resolves identity using `POST /v1/caregivers/notification/resolve`, and refreshes current profile permissions. It shows the server-selected person's name and an honest notification description. Opening the dashboard revalidates the delivery and permissions, selects that exact profile and waits for app context before navigation. A missing/revoked profile cannot fall through to the active or first followed patient. The existing dashboard retains its current per-section read permissions. Neither tap nor resolution confirms a dose or proves notification receipt.

A newer tap invalidates the previous request immediately. Account transitions, closing/blur/unmount and relocking invalidate pending work; old identity is hidden on the first unlock frame while a fresh read starts. The handoff is cleared on exit/account change and is never persisted, logged or appended to a route. Expired/unknown/revoked lookups share an unavailable state; network and server failures have separate retry states.

## Automated evidence

`apps/api/test/caregiver-push-envelope.test.ts` contains 13 cases exercising the actual dispatcher with SQL/provider doubles. Before the fix, scoped local execution had 4 passes and 9 failures; after the fix all 13 passed. This local run used TypeScript transpilation and Node assertions, not the full repository Vitest setup, real PostgreSQL or native OS delivery.

The cases cover AR/EN generic content, hidden-medication mode, unsafe grouped caregiver payloads, relationship-bound summaries, locale fallback, patient reminder compatibility, revoked access, absent devices, a confirmation during device lookup, and loss of the pending dose/current lease. An isolated strict TypeScript check also verified the provider data contract.

CI must run the committed Vitest suite and all existing regression tests on the exact candidate HEAD, with PostgreSQL 16 and 17. Do not waive a failure as obsolete without reading the failing assertion and tracing the affected contract.

## Mobile integration evidence — 14 September 2026

The actual repository Vitest runner passed 112 targeted tests: 32 notification-screen cases, 10 handoff/listener cases, 19 shipped-Shell cases, 38 grouped-listener cases, 6 caregiver wiring cases and 7 shared grouped-reminder cases. The screen tests run checked-in TSX and request-scope code with synthetic React/native/network boundaries; they are not physical-device tests. Mobile TypeScript, changed-file lint and the production web export also passed locally. Broader mobile/shared regression and the final remote candidate gates must be recorded separately.

CI #919 on predecessor `152ee5a7e4e698ffb1ca5c7f6ca46f970e499f59` failed one route-inventory assertion: the new resolver was missing from its authenticated-route map. All 35 resolver PostgreSQL integration cases passed in the inspected PostgreSQL 17 job. This continuation adds the missing authenticated classification; the inventory and authentication requirements remain in force.

## Before-send boundary

Immediately before a push escalation, the worker checks the authoritative occurrence joined to the exact currently-sending outbox lease. Taken, taken-late, skipped, cancelled, missing and no-longer-leased deliveries must not reach the provider. A provider call already accepted cannot be retracted by this check; it does not eliminate every possible confirmation/send race.

## Required device and database proof — still outstanding

1. Confirm actual app build/project identity, push credentials, authenticated device registration and notification permission on a physical Android and iOS device, without exposing credentials in logs.
2. Using synthetic test accounts only, establish a consented active patient/caregiver relationship with notification permission. Confirm that a patient reminder happens first and the caregiver is not alerted before the configured escalation stage.
3. Leave one dose unconfirmed: prove the caregiver sees only generic title/body on the lock screen and provider payload contains only the allowlisted routing data. Repeat with medication disclosure enabled and disabled.
4. Tap the notification with the app foregrounded, backgrounded and cold-started. Prove authenticated navigation and authorized current details; signed-out, wrong-account and revoked-caregiver states must disclose nothing. The software integration is covered by automated tests; installed-device receipt/tap evidence is still outstanding. Use two followed patients with an unrelated active profile, newer taps, account changes, both lock modes and revoked access.
5. Confirm the dose before enqueue, after enqueue and during dispatch device lookup. Prove the real PostgreSQL worker skips the pending escalation without falsely reporting it sent. Test cancelled/skipped/taken-late doses and an expired/replaced lease as well.
6. Repeat with no connection, denied OS permission, expired device token and revoked relationship. Distinguish provider acceptance, phone receipt and user viewing. Do not report a push as seen solely because the provider returned a ticket.
7. Verify authenticated detail wording says the confirmation has not arrived rather than asserting non-adherence. Show the latest state when a delayed notification is opened after the confirmation synchronizes.
8. Finish PR #22 controlled-release gates: live auto-deploy disabled safely, rollback/backup verified, worker then API at identical SHA, successful job heartbeats, readiness/version/provider checks and request-log privacy evidence.

Release record must include the exact commit, test run IDs, OS/app versions, synthetic account roles, observed results and remaining limitations. Never attach real patient data, device tokens, private keys or service credentials.
