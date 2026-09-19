# Push delivery semantics

What the system can and cannot promise about a medication reminder reaching a
patient's phone. Written for P10-1; the claims about Expo were verified against
Expo's *Sending notifications* documentation, retrieved 2026-09-05.

## The guarantee

**Retry-oriented dispatch, with a documented duplicate window.**

This describes eligible outbox work, not a guarantee of handset delivery.
Revoked access, obsolete dose state, expiry or terminal provider failures may
stop an intent without a successful send.

Not exactly-once. Exactly-once delivery to an external push provider is not
achievable here and is not claimed anywhere in the code.

## Why not exactly-once

Exactly-once across a network boundary requires the receiver to recognise a
retry as a retry. Expo's push API documents no idempotency key and no request
deduplication, so a retried send is simply a second message.

That leaves one irreducible window: a send whose HTTP call times out has an
unknown outcome. Expo may have accepted it or may not, and there is no way to
ask, because a timed-out call returns no ticket id.

## The decision, and why it goes this way

An ambiguous result is **retried** (`AMBIGUOUS_IS_RETRYABLE = true` in
`apps/worker/src/jobs/dispatcher.ts`).

The two failure modes are not symmetric for a medication app:

- a duplicate reminder is an annoyance;
- a lost reminder can mean a dose not taken — and worse, the escalation ladder
  then alerts the family about a dose the patient was never told was due.

So the duplicate window is accepted and written down rather than closed by
dropping a message of unknown fate.

## What a "sent" row actually means

`notification_deliveries.status = 'sent'` means **the provider accepted the
message**. It does not mean the patient saw it, and no part of the app should
present it that way.

`provider_message_id` stores Expo's **ticket id**. Per Expo's documentation, a
ticket `status` of `ok` means the message was received by Expo's servers,
explicitly *not* that it was received by the user.

## Tickets vs receipts (verified 2026-09-05)

| | Ticket | Receipt |
|---|---|---|
| When | Returned by the send call | Fetched later, `POST https://exp.host/--/api/v2/push/getReceipts` with `{"ids": [...]}` |
| `status` values | `ok`, `error` | `ok`, `error` |
| What `ok` proves | Expo's servers received the message | Expo's delivery **to FCM/APNs** succeeded |
| What it does not prove | Anything about the device | That the device displayed it, or that the user saw it |
| Retention | — | Cleared after **24 hours** |
| Recommended read time | — | ~**15 minutes** after sending |
| Idempotency | None documented | None documented |

Note the ceiling: a receipt confirms one hop further than a ticket — Expo to
FCM/APNs — and still stops short of the handset. Neither is a delivery
confirmation in the sense a patient or a caregiver would mean.

## Implemented receipt reconciliation

`apps/worker/src/jobs/push-receipts.ts` polls accepted Expo tickets after the
code-defined 15-minute delay, in batches of 100, with a 24-hour expiry window.
The 13 September [receipt audit](audit/2026-09-13-push-provider-receipts.md)
records its introduction.

A successful receipt marks the row `delivered`; this means the provider handoff
succeeded. It does not mean that the phone displayed it. A matching
`DeviceNotRegistered` receipt retires the original endpoint using its stored
fingerprint, so an old receipt cannot deactivate a replacement token. Terminal
errors and expired receipts are recorded as failures. Missing ticket IDs after
an ambiguous send still cannot be reconciled by this job.

## Current intent and local reminders

The 19 September audit adds a last eligibility check before dose dispatch:
completed/cancelled/paused doses and superseded snoozes must not send an obsolete
message. Grouped reminders are rebuilt from their remaining eligible members.
Snooze reminders retain their own frozen deadline and event identity rather than
reusing a consumed escalation stage. Lease renewal uses a separate committed
connection, like finalisation; native PostgreSQL concurrency proof is required.

Local native notifications use the authorized cached dose window and pending
offline actions. They are separate from remote push and remain subject to device
permission and operating-system behavior. A real foreground/locked/offline
matrix is required; source tests do not establish presentation on iOS.

## Crash behaviour

Every crash window is exercised in `apps/api/test/worker-reliability.test.ts`
("P10-1 CRASH WINDOWS"). The claim those tests establish is not exactly-once —
it is that every crash leaves a state that recovers by itself, and that no crash
lets a worker write a result for a row it no longer owns.

| Window | Crash point | Outcome |
|---|---|---|
| 1 | Before the claim commits | Row untouched, still `queued`, no attempt consumed |
| 2 | After claim, before send | Lease expires; another worker recovers it |
| 3 | During the provider call | Unknown outcome; lease expires; retried |
| 4 | After a successful send, before finalising | Recovered and re-sent — **the duplicate window** |
| 5 | After finalising | Terminal; never re-claimed |
| 6 | Stale worker returns after its lease was reassigned | Writes nothing; the new owner's result stands |
| 7 | Mid-batch | Finalised rows stay finalised; the rest recover independently |

The mechanism is a lease: `lease_until` gives a claim an expiry so a dead
worker's batch returns to the pool, and `lease_token` is stamped fresh on every
claim and matched on every finalisation so a worker whose lease was taken away
cannot overwrite the result of the worker that took it.

## Not claimed

- Exactly-once delivery.
- That `sent` means the patient received or saw the notification.
- That Expo provides any idempotency or deduplication guarantee.
- Universal or exactly-timed delivery in foreground, background or locked states.
  On 19 September one synthetic iOS reminder received a successful provider
  receipt and the user confirmed a visible alert after APNs configuration was
  repaired. That single observation does not validate every device state, token
  rotation, group, snooze or offline scenario, nor the newer audit revision.
