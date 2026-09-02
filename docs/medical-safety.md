# The medical safety boundary

Dawaee is a medication **organisation, reminder, adherence and caregiver-support
tool**. It is not a doctor, a pharmacist, a prescription service or a diagnostic
system.

That sentence is easy to write. What follows is where it is actually enforced.

## The app never advises on dosing

There is no code path that recommends a dose, changes one, or reacts to a missed
one with a correction. A missed dose surfaces exactly one message, in both
languages:

> إذا فاتتك جرعة، اتّبع تعليمات طبيبك أو الصيدلي. لا تضاعف الجرعة من تلقاء نفسك.
>
> If you miss a dose, follow your doctor or pharmacist's instructions. Do not
> double a dose on your own.

An integration test asserts that no dose payload contains "double the",
"take two", "skip the next" or "increase the dose".

## OCR output is a suggestion, never a record

`POST /v1/ocr/analyze` returns `requiresUserConfirmation: true` and
`schedulesCreated: 0`. It writes nothing. The confirmation screen shows every
detected field as an editable input, tagged "مُستخرج بالذكاء الاصطناعي" with its
confidence, above the disclaimer that the values may be inaccurate.

A medication's `identity_source` column records which it was — `user`,
`ocr_confirmed_by_user`, or `barcode_confirmed_by_user` — so the provenance of
every record is auditable after the fact.

Prescription scanning is held to the same rule: it extracts candidate lines and
**never** creates a schedule.

## High-risk changes need a second confirmation

Changing a medication's identity, strength, dose quantity, dose unit or timing
returns `409 high_risk_confirmation_required` with the before/after values. The
client must re-submit with `confirmHighRiskChange: true`.

This is a **usability safeguard against a mis-tap**, not clinical validation.
The app has no opinion on whether the new value is medically appropriate and
never suggests one.

## Adherence figures are not clinical claims

Every adherence response carries `disclaimerKey: 'adherence.disclaimer'`, and
the UI renders it immediately beneath the percentage — not buried in a footer:

> تُحتسب هذه النسبة من تأكيدات المستخدم فقط ولا تُثبت طبياً أن الدواء تم تناوله.
>
> This is based on user confirmations and does not clinically verify medication
> consumption.

PRN ("as needed") medications generate no occurrences at all, so they can never
drag an adherence figure down for doses that were never scheduled.

## Symptoms and measurements are recorded, not interpreted

Post-dose notes are stored verbatim. The system does not classify them, does not
link them to an adverse-effect conclusion, and does not surface them as a
clinical signal.

Health measurements are recorded and charted with **no** judgement: no "high",
no "normal", no colour coding of a value, no ordering by severity.

## Reports contain no conclusions

The doctor/pharmacist report is deliberately inert: medication, schedule,
confirmation history, missed doses. No flags, no highlighting, no ordering by
severity, no advice. The clinician reading it draws their own conclusions —
which is the entire point.

## Expiry and refills state facts and stop

An expiry warning says the date. It does **not** tell anyone to take or discard
an expired medication; that is a pharmacist's call. Prescription renewal
warnings say a renewal may be needed and never claim the system can renew one,
because it cannot.

## Emergency card

Every field is user-entered and labelled "المعلومات مُدخلة من المستخدم /
Information provided by the user". The system infers no condition from a
medication list. The public QR payload restates it so any consumer sees it.

## Notification capability claims

The app does not claim OS capabilities it does not have:

- **iOS critical alerts** (which bypass silent mode) require an Apple
  entitlement that medication apps are rarely granted. The code does not pretend
  to have it; it uses `timeSensitive`, the strongest level available without it.
- **Android exact alarms** can be revoked by the user from Android 13. The app
  detects this and tells them, because an inexact medication reminder is a real
  degradation, not a detail to hide.
- Local notifications are scheduled on-device **in addition to** push, because
  push needs a network and a local alarm does not.
