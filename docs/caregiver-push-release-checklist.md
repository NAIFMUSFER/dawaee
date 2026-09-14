# Caregiver push release checklist

Status: **NOT RELEASE-VERIFIED**. PR #24 depends on the release controls in PR #22. No production deployment or PR merge is authorized by this checklist.

## Approved product contract

The channel is an app push notification, not SMS. A patient reminder precedes caregiver escalation according to the configured policy. A missing server confirmation means **not confirmed**, not proof that the patient did not take a medication. Offline confirmations may not have synchronized yet.

The provider-bound caregiver envelope is deliberately generic, even when detailed medication reminders are enabled for the patient's own device:

- Arabic title: `دوائي — تنبيه متابعة`
- Arabic body: `لديك تنبيه يحتاج إلى متابعتك. افتح دوائي لعرض التفاصيل.`
- English title: `Dawaee — Follow-up alert`
- English body: `You have a follow-up alert. Open Dawaee to view the details.`
- Data allowlist: `deliveryId`, `kind`. Never include patient/medicine names, dose IDs, clinical timing or Taken/Snooze/Skip actions on a caregiver push.

The detailed database outbox record is retained for authorized in-app access. A delivery ID is a routing reference, never an authorization credential. The current dose state must be fetched and authorized again when showing details; a stale push must not assert that the dose is still unconfirmed.

## Automated evidence

`apps/api/test/caregiver-push-envelope.test.ts` contains 13 cases exercising the actual dispatcher with SQL/provider doubles. Before the fix, scoped local execution had 4 passes and 9 failures; after the fix all 13 passed. This local run used TypeScript transpilation and Node assertions, not the full repository Vitest setup, real PostgreSQL or native OS delivery.

The cases cover AR/EN generic content, hidden-medication mode, unsafe grouped caregiver payloads, relationship-bound summaries, locale fallback, patient reminder compatibility, revoked access, absent devices, a confirmation during device lookup, and loss of the pending dose/current lease. An isolated strict TypeScript check also verified the provider data contract.

CI must run the committed Vitest suite and all existing regression tests on the exact candidate HEAD, with PostgreSQL 16 and 17. Do not waive a failure as obsolete without reading the failing assertion and tracing the affected contract.

## Before-send boundary

Immediately before a push escalation, the worker checks the authoritative occurrence joined to the exact currently-sending outbox lease. Taken, taken-late, skipped, cancelled, missing and no-longer-leased deliveries must not reach the provider. A provider call already accepted cannot be retracted by this check; it does not eliminate every possible confirmation/send race.

## Required device and database proof — still outstanding

1. Confirm actual app build/project identity, push credentials, authenticated device registration and notification permission on a physical Android and iOS device, without exposing credentials in logs.
2. Using synthetic test accounts only, establish a consented active patient/caregiver relationship with notification permission. Confirm that a patient reminder happens first and the caregiver is not alerted before the configured escalation stage.
3. Leave one dose unconfirmed: prove the caregiver sees only generic title/body on the lock screen and provider payload contains only the allowlisted routing data. Repeat with medication disclosure enabled and disabled.
4. Tap the notification with the app foregrounded, backgrounded and cold-started. Prove authenticated navigation and authorized current details; signed-out, wrong-account and revoked-caregiver states must disclose nothing. This tap-to-details integration has NOT yet been established by this change.
5. Confirm the dose before enqueue, after enqueue and during dispatch device lookup. Prove the real PostgreSQL worker skips the pending escalation without falsely reporting it sent. Test cancelled/skipped/taken-late doses and an expired/replaced lease as well.
6. Repeat with no connection, denied OS permission, expired device token and revoked relationship. Distinguish provider acceptance, phone receipt and user viewing. Do not report a push as seen solely because the provider returned a ticket.
7. Verify authenticated detail wording says the confirmation has not arrived rather than asserting non-adherence. Show the latest state when a delayed notification is opened after the confirmation synchronizes.
8. Finish PR #22 controlled-release gates: live auto-deploy disabled safely, rollback/backup verified, worker then API at identical SHA, successful job heartbeats, readiness/version/provider checks and request-log privacy evidence.

Release record must include the exact commit, test run IDs, OS/app versions, synthetic account roles, observed results and remaining limitations. Never attach real patient data, device tokens, private keys or service credentials.
