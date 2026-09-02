# Defects the tests caught

Every one of these was found by a test that failed, not by review. They are
recorded because the *class* of each is more useful than the fix.

---

## 1. Unlimited OTP guesses — authentication bypass

**Severity: critical.** The OTP attempt counter incremented inside the same
transaction that then threw to signal "wrong code". The throw rolled the
increment back, so `attempts` never advanced past 1 and the lockout never
triggered. An attacker could brute-force a 6-digit code indefinitely and take
over any account by phone number alone.

Caught by: `auth.test.ts › locks out after too many wrong guesses` — six wrong
guesses returned `401` six times instead of `401×5` then `429`.

**Fix:** `checkOtp` now *returns* an outcome and the caller commits before
raising the error. The distinction is load-bearing and is commented as such at
the call site.

**Lesson:** a security counter written inside a transaction that fails by
throwing is not a counter.

---

## 2. Refresh-token theft revocation was rolled back

**Severity: high.** Same root cause, different consequence. On detecting a
reused refresh token, `app.rotate_session` revokes every session on that device
— then the caller threw, rolling the revocation back. The stolen session stayed
alive; the defence was inert.

Caught by: `auth.test.ts › rotates the refresh token and invalidates the old
one` — the replacement token still worked after the theft was "detected".

**Fix:** `rotateSessionAttempt` returns the outcome; `assertRotated` raises
afterwards.

---

## 3. Caregiver could grant themselves permissions — privilege escalation

**Severity: critical.** The RLS `UPDATE` policy on `caregiver_relationships`
allowed a caregiver to update their own row so they could accept or leave.
`WITH CHECK` only sees the new row, so it could not distinguish that from
rewriting `permissions` to include `edit_medication` and `manage_caregivers`.

Caught by: `db/seed/rls_probe.sql` — the adversarial probe attempted exactly
this and it succeeded.

**Fix:** migration 0009 adds a `BEFORE UPDATE` trigger comparing OLD and NEW.
A caregiver may change exactly one thing: leaving the circle.

**Lesson:** RLS cannot express "this column may not change". That needs a
trigger.

---

## 4. Schedule edits silently did nothing

**Severity: high (patient safety).** `dose_occurrences` had SELECT, INSERT and
UPDATE policies but no DELETE policy. RLS is default-deny, so
`rematerializeSchedule` deleted zero rows. Changing a medication's times
appeared to succeed and left every old dose in place — the patient would keep
being reminded at the **old** times indefinitely.

Caught by: `medications.test.ts › supports every rule kind and regenerates doses
on change` — `futureDosesRemoved` was 0 where it should have been 42.

**Fix:** migration 0012 adds a narrow DELETE policy gated on `edit_schedule`.

**Lesson:** default-deny is correct, and it means every operation you intend to
perform needs an explicit policy. The absence of one fails *silently*.

---

## 5. Resuming a paused medication left it permanently silent

**Severity: high (patient safety).** Pausing cancels future doses. Resuming
called the materializer — but the cancelled rows still occupied their
`(schedule_id, scheduled_at)` slots, so `ON CONFLICT DO NOTHING` skipped them.
The medication showed as active and never reminded anyone again.

Caught by: only when the **full** suite ran in sequence, where a later test
found no actionable dose. In isolation it passed.

**Fix:** `reviveCancelledDoses` restores future untouched doses before topping
up the horizon.

**Lesson:** a test that only passes in isolation is hiding state.

---

## 6. The narrowest caregiver grant was the one that did not work

**Severity: medium.** A caregiver granted only `view_adherence` saw **zero** —
the adherence query joined `medications` and `medication_schedules`, which that
grant does not cover, so the join eliminated every row. The most
privacy-preserving option in the product was silently useless.

Caught by: `escalation.test.ts › lets the son see adherence but not the
medication list`.

**Fix:** migration 0013 lets `view_adherence` read schedules (timing
thresholds, not medical identity); the API `LEFT JOIN`s medications and returns
`byMedicationWithheld: true` instead of names.

---

## 7. `missed` was final, so patients could not correct their own history

**Severity: medium (product).** `missed` sat in the terminal set alongside
`taken`, so a patient who took their medication and forgot to tap could never
record it. That teaches people their adherence record is fiction.

Caught by: `dose-status.test.ts › lets a missed dose still be recorded late`.

**Fix:** separated *derived* statuses (recomputed from the clock) from
*recorded* ones (user-authored, final). `missed` stops reminders but stays
editable inside the confirmation window.

---

## 8. Duplicate detection flagged different strengths as the same drug

**Severity: medium (patient safety).** Normalised Levenshtein treated
"Humalog Mix25" and "Humalog Mix50" as a 96% match — they are one character
apart. The app would have nudged a patient toward merging two records that must
stay separate.

Caught by: `medications.test.ts › handles fifty medications on one profile`,
where "Bulk Medication 1" and "Bulk Medication 2" collided.

**Fix:** differing numeric tokens now collapse the similarity score rather than
raising it, with regression tests for insulin and antibiotic naming patterns.

---

## 9. RTL text was reversed, not laid out

**Severity: medium (usability).** Found by looking at a screenshot, not by a
test. "500 mg" rendered as "mg 500" in Arabic, and "+966…397" as "397…966+" —
the classic bidi trap where a Latin fragment inside an RTL paragraph is
visually reordered.

**Fix:** `formatMeasure` and `bidi` in the i18n layer wrap mixed-script
fragments in a Unicode first-strong isolate. Units are localized
("500 ملغم", "1 قرص"). Centralised so no screen has to know the trick.

**Lesson:** an RTL layout can be structurally perfect and still read wrong.
Look at it.

---

## Still open

See [status.md](status.md) for what has not been verified.
