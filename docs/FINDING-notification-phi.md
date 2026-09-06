# FINDING — Medication name and dose are disclosed through notification surfaces

**Status:** OPEN — unresolved privacy finding. No product behaviour changed.
**Found during:** P3 (local cache encryption). **Not closed by P3.**
**Severity recommendation:** **Medium–High.** Medium on likelihood — it requires
physical proximity to the phone or access to a notification mirror — but High on
impact, because the disclosed fact is a medication name, which for a substantial
class of drugs identifies a diagnosis directly (antiretrovirals, antipsychotics,
oncology, fertility, addiction treatment). The combination places it above the
encrypted-cache issue it sits beside: that one needed the storage file, this one
needs a glance.

## Threat scenario

A patient's phone lies face-up on a desk, a table at work, or a car seat. At the
scheduled dose time the reminder renders on the locked screen:

> 💊 Medication Reminder
> Clozapine — 1 tablet with food. Scheduled 20:00.

A colleague, a relative, a flatmate, or anyone standing behind them in a queue
reads a specific drug and dose without touching the device. No compromise of any
kind is required — this is the notification working exactly as designed.

Secondary scenarios: notification mirroring to a paired laptop, watch, TV or car
display; screen sharing during a call; a screenshot taken for an unrelated
reason; and Android's notification history, which retains the text for 24 hours
and is readable from Settings by anyone holding the unlocked phone.

## Affected fields

| Field | Where |
|---|---|
| Medication name | notification `body`; `subtitle` when voice reminders are on |
| Dose quantity + unit | notification `body`, `subtitle` |
| Food instruction | notification `body` |
| Scheduled local time | notification `body` |
| Patient display name | escalation notifications to caregivers (server-generated) |

Not affected: the client-side `data` payload carries only `doseId`,
`medicationId`, `kind` — identifiers, no PHI.

## Affected OS surfaces — audited

| Surface | Carries PHI? | Evidence |
|---|---|---|
| **iOS Notification Center / lock screen** | **Yes** | `apps/mobile/src/notifications/index.ts:211-229` builds `body` from `dose.medication.name` and `${doseQuantity} ${doseUnit}` |
| **Android notification shade** | **Yes** | same code path, channel `medication-critical` |
| **Android notification history** (Settings ▸ Notifications ▸ History, 24 h) | **Yes** | OS-retained copy of the same text |
| **Scheduled-notification persistence** | **Yes** | `scheduleNotificationAsync` stores the fully-rendered body in `UNUserNotificationCenter` (iOS) and the Expo/AlarmManager store (Android), up to the prefetch window ahead of time — *outside* the app's encrypted cache and outside AsyncStorage |
| **Expo notification `data` payload** | **No** | ids only — `{ doseId, medicationId, kind }` |
| **Server push payload** | **Yes** | `apps/worker/src/jobs/reminders.ts:263-269` renders the body server-side; `apps/api/src/providers/push.ts:33-34` sends `title`/`body` to the push provider |
| **`notification_queue` DB row** | **Yes** | `reminders.ts:290-301` persists `title`, `body`, and a JSON payload containing `patientName` and `medicationName` |
| **Push provider logs (Expo/FCM/APNs)** | **Likely, not verifiable by us** | the body transits and is retained by third-party infrastructure per their own policies |
| **Application logs** | **No** | grep of `reminders.ts` and `push.ts` found no log statement carrying `medication_name` or `body` |
| **Analytics / crash logs** | **No** | no analytics or crash-reporting SDK is installed in this app |

## Current behaviour

`'reminder.body': '{medication} — {dose}. Scheduled {time}.'` — always, with no
setting to change it, on both the client-scheduled local notification and the
server-scheduled push. `interruptionLevel: 'timeSensitive'` means it renders
through Focus modes.

## Accessibility benefit (the reason it is written this way)

This app is built for elderly patients and for caregivers managing someone
else's regimen. A named reminder is not decoration:

- A patient on eight medications must know *which* one this alert is for. A
  generic reminder means unlocking, navigating and reading — every dose, several
  times a day.
- The lock-screen "Taken" / "Skip" buttons exist so a dose can be confirmed
  without opening the app at all. Those buttons are meaningless if the
  notification does not say what is being confirmed, and a patient who taps
  "Taken" on an unnamed reminder is recording an adherence fact they did not
  actually verify.
- For a patient with cognitive impairment, the name in the notification *is* the
  memory aid. Removing it may reduce adherence, and non-adherence is the harm
  this entire product exists to reduce.

This is a genuine safety-versus-privacy trade, not a bug with an obvious fix.

## Privacy cost

Continuous, passive, unbounded disclosure of diagnosis-adjacent data to anyone
in visual range, several times a day, for the life of the install — plus a
24-hour retained copy on Android and third-party retention at the push provider.

## Mitigation options evaluated

**A. Generic by default — "Medication reminder — tap to view"**
*Pro:* closes the lock-screen, history and provider-log exposure in one change;
no configuration for the user to find. *Con:* breaks lock-screen confirmation
for multi-medication patients, which is the app's headline accessibility
feature; harms exactly the cognitively-impaired users least able to compensate.
Also fails silently — the patient never learns why reminders got less useful.

**B. User-selectable setting — "Hide medication details on the lock screen"**
*Pro:* the person whose data it is decides, which is the correct locus for a
disclosure judgement; both populations are served. *Con:* a default has to be
picked anyway, so this is not an answer on its own — it is the mechanism that
makes an answer humane. Discoverability is the risk: a privacy control nobody
finds protects nobody.

**C. Detailed only after explicit opt-in**
*Pro:* strongest privacy posture; matches "minimum necessary" disclosure.
*Con:* every new user's first experience is a degraded reminder, and the opt-in
prompt would have to appear during onboarding, where it competes with
notification permission and adds a decision an elderly user is poorly placed to
make cold — before they have ever seen a reminder and can judge the trade.

**D. OS-level visibility controls**
Android supports per-channel lock-screen visibility (`VISIBILITY_PRIVATE` hides
content until unlock, keeping the full text in the shade) and this is settable
on the `medication-critical` channel. iOS offers "Show Previews: When Unlocked"
per app, but only the *user* can set it — there is no API to request it — and
iOS notification actions still work with previews hidden. *Pro:* on Android this
gets most of the benefit at almost no accessibility cost, because the full text
returns the moment the phone is unlocked. *Con:* asymmetric across platforms;
does not touch the push-provider or `notification_queue` copies.

## Recommended product policy

**B + D, with detail ON by default and a prominent, early control — not A or C.**

Reasoning: for a medication app the default must not silently degrade the safety
feature the product exists to deliver. A generic default (A) or opt-in (C) trades
a certain adherence cost against an uncertain privacy benefit, and the person
best placed to judge whether their household, workplace or ward makes lock-screen
disclosure risky is the patient, not us.

Concretely:

1. Add `hideMedicationInNotifications` to preferences, default **false**.
2. Surface it during notification setup — the moment the patient first sees what
   a reminder looks like — not buried in a settings sub-page, so the choice is
   made with the trade visible.
3. When on: body becomes `t('reminder.bodyPrivate')` — "Medication reminder —
   tap to view" — on **both** the client and the worker, and the
   `notification_queue` row stores the generic text, so the PHI never reaches
   the push provider either.
4. Independently of the setting, set Android channel visibility to
   `VISIBILITY_PRIVATE` **by default**. This is close to free: the shade still
   shows the full text once unlocked, so the accessibility argument is largely
   unaffected, while the face-up-on-a-desk scenario is closed.
5. Note in-app that iOS "Show Previews" is a system setting the patient controls.

Item 4 is the one change worth making even if the rest is deferred.

## Residual risk after the recommended policy

- Detail remains the default, so a patient who never opens the setting is still
  disclosing on iOS lock screens (Android is covered by item 4).
- Caregiver escalation notifications carry the **patient's name plus their
  medication** to a second person's device; that person's own lock screen is
  outside this app's control entirely.
- Historical `notification_queue` rows and any push-provider retention already
  contain PHI. Retention and purge for that table is a separate, unaudited
  question.
- On Android, notification history entries written before item 4 ships retain
  the text for their 24-hour window.

## Not done

No product behaviour was changed. This finding is reported for a decision.
