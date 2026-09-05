import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { caregiverMissedText, reminderText } from '../src/reminder-text.js';

/**
 * Notification text, which named the medication and the dose unconditionally.
 *
 * That text reaches the lock screen, Android's 24-hour notification history,
 * the OS scheduled-notification store, the notification_deliveries rows and
 * the push provider. A phone lying face-up on a desk told anyone walking past
 * which drug its owner takes — and for antiretrovirals, antipsychotics,
 * oncology, fertility or addiction treatment, the drug names the diagnosis.
 */

const ROOT = resolve(import.meta.dirname, '../../..');

const BASE = {
  medicationName: 'Clozapine',
  doseText: '1 tablet',
  time: '20:00',
  food: 'with food',
};

describe('the default says nothing about the medication', () => {
  for (const locale of ['ar', 'en'] as const) {
    it(`names no drug or dose by default (${locale})`, () => {
      const text = reminderText({ locale, ...BASE });
      expect(text.body).not.toContain('Clozapine');
      expect(text.body).not.toContain('1 tablet');
      expect(text.voice).not.toContain('Clozapine');
      expect(text.containsMedicationDetail).toBe(false);
    });

    it(`treats an absent preference as private, not as permission (${locale})`, () => {
      const undef = reminderText({ locale, showMedication: undefined, ...BASE });
      const off = reminderText({ locale, showMedication: false, ...BASE });
      expect(undef.body).toBe(off.body);
      expect(undef.containsMedicationDetail).toBe(false);
    });
  }

  /**
   * A notification an elderly patient cannot act on is not a privacy win. The
   * generic text still has to say that a dose is due and when.
   */
  it('still tells the patient there is a dose and when', () => {
    const en = reminderText({ locale: 'en', ...BASE });
    expect(en.body).toContain('20:00');
    expect(en.body.length).toBeGreaterThan(20);
    const ar = reminderText({ locale: 'ar', ...BASE });
    expect(ar.body).toContain('20:00');
    expect(ar.body.length).toBeGreaterThan(20);
  });

  it('keeps the title, so the notification is still recognisably a reminder', () => {
    expect(reminderText({ locale: 'en', ...BASE }).title)
      .toBe(reminderText({ locale: 'en', showMedication: true, ...BASE }).title);
  });
});

describe('opting in restores the detailed text', () => {
  it('names the drug and dose once the patient asks', () => {
    const text = reminderText({ locale: 'en', showMedication: true, ...BASE });
    expect(text.body).toContain('Clozapine');
    expect(text.body).toContain('1 tablet');
    expect(text.body).toContain('20:00');
    expect(text.containsMedicationDetail).toBe(true);
  });

  it('goes back to generic when the patient opts out again', () => {
    const on = reminderText({ locale: 'en', showMedication: true, ...BASE });
    const off = reminderText({ locale: 'en', showMedication: false, ...BASE });
    expect(on.body).toContain('Clozapine');
    expect(off.body).not.toContain('Clozapine');
  });
});

describe('the spoken line cannot be looser than the printed one', () => {
  /**
   * Saying a drug name aloud in a room is a wider disclosure than printing it
   * on a screen, so voice follows the same flag rather than its own.
   */
  it('speaks no medication name by default', () => {
    for (const locale of ['ar', 'en'] as const) {
      expect(reminderText({ locale, ...BASE }).voice).not.toContain('Clozapine');
    }
  });

  it('speaks it only after the same opt-in', () => {
    expect(reminderText({ locale: 'en', showMedication: true, ...BASE }).voice)
      .toContain('Clozapine');
  });

  it('has no separate voice flag that could disagree', () => {
    const src = readFileSync(join(ROOT, 'packages/shared/src/reminder-text.ts'), 'utf8');
    expect(src).not.toMatch(/showVoiceMedication|voiceShowMedication|allowVoiceDetail/);
  });
});

describe("the caregiver copy follows the patient's choice", () => {
  it('withholds the medication from a caregiver alert by default', () => {
    const text = caregiverMissedText({
      locale: 'en', patientName: 'Fatima', medicationName: 'Clozapine', time: '20:00',
    });
    expect(text.body).not.toContain('Clozapine');
    expect(text.body).toContain('Fatima');
    expect(text.containsMedicationDetail).toBe(false);
  });

  it('includes it once the patient has opted in', () => {
    const text = caregiverMissedText({
      locale: 'en', showMedication: true, patientName: 'Fatima',
      medicationName: 'Clozapine', time: '20:00',
    });
    expect(text.body).toContain('Clozapine');
  });

  it('still tells the caregiver who and when, so the alert remains actionable', () => {
    const text = caregiverMissedText({
      locale: 'en', patientName: 'Fatima', medicationName: 'Clozapine', time: '20:00',
    });
    expect(text.body).toContain('Fatima');
    expect(text.body).toContain('20:00');
  });
});

describe('one builder, so the phone and the server cannot disagree', () => {
  it('is used by the mobile scheduler', () => {
    const src = readFileSync(join(ROOT, 'apps/mobile/src/notifications/index.ts'), 'utf8');
    expect(src).toContain('reminderText({');
    // and no longer builds a body from the detailed template itself
    expect(src).not.toContain("'reminder.bodyWithFood'");
  });

  it('is used by the worker', () => {
    const src = readFileSync(join(ROOT, 'apps/worker/src/jobs/reminders.ts'), 'utf8');
    expect(src).toContain('reminderText({');
    expect(src).toContain('caregiverMissedText({');
    expect(src).not.toContain("'reminder.bodyWithFood'");
  });

  it('reads the flag from the patient row rather than defaulting open', () => {
    const src = readFileSync(join(ROOT, 'apps/worker/src/jobs/reminders.ts'), 'utf8');
    expect(src).toContain('COALESCE(up.show_medication_in_notifications, false)');
  });

  it('keeps the medication out of the stored payload in generic mode', () => {
    const src = readFileSync(join(ROOT, 'apps/worker/src/jobs/reminders.ts'), 'utf8');
    expect(src).toContain('...(showMedication ? { medicationName: dose.medication_name } : {})');
  });
});

describe('the platform pieces around the text', () => {
  const mobile = readFileSync(join(ROOT, 'apps/mobile/src/notifications/index.ts'), 'utf8');

  /**
   * Android channel visibility is independent of the opt-in and applies in both
   * modes: PRIVATE hides the text on the lock screen and shows it in full once
   * unlocked, so it costs almost nothing in the mode that has nothing to hide.
   */
  it('sets the Android channel to PRIVATE lock-screen visibility', () => {
    expect(mobile).toContain('lockscreenVisibility: N.AndroidNotificationVisibility.PRIVATE');
    expect(mobile).not.toContain('AndroidNotificationVisibility.PUBLIC');
  });

  /**
   * The action buttons are what make a generic reminder usable — the patient
   * confirms without the name ever being rendered. They must be untouched.
   */
  it('keeps Taken / Snooze / Skip on the notification', () => {
    expect(mobile).toContain('categoryIdentifier: MEDICATION_CATEGORY_ID');
    const categories = mobile.slice(mobile.indexOf('configureCategories'));
    for (const action of ['taken', 'snooze', 'skip']) {
      expect(categories.toLowerCase(), action).toContain(action);
    }
  });

  /**
   * Text is baked in when a notification is scheduled — the OS holds the
   * rendered string, not a template — and reminders are built a week ahead. A
   * patient who turns disclosure off would otherwise keep receiving named
   * reminders for days and conclude the setting does nothing.
   */
  it('rebuilds already-scheduled reminders when the setting changes', () => {
    const store = readFileSync(join(ROOT, 'apps/mobile/src/state/app-store.tsx'), 'utf8');
    expect(store).toContain('disclosureChanged');
    expect(store).toContain('rebuildRemindersFromCache');
    expect(mobile).toContain('export async function rebuildRemindersFromCache');
    // The rebuild cancels first — see rescheduleLocalNotifications.
    expect(mobile).toContain('cancelAllScheduledNotificationsAsync');
  });

  it('passes the preference into the scheduler', () => {
    const today = readFileSync(join(ROOT, 'apps/mobile/app/(tabs)/today.tsx'), 'utf8');
    expect(today).toContain('showMedication: preferences.showMedicationInNotifications');
  });
});

describe('the preference is per account and private by default', () => {
  it('defaults to false in the database', () => {
    const sql = readFileSync(join(ROOT, 'db/migrations/0020_notification_privacy.sql'), 'utf8');
    expect(sql).toContain('show_medication_in_notifications boolean NOT NULL DEFAULT false');
    // No backfill to true: existing accounts become LESS exposed, never more.
    expect(sql).not.toMatch(/UPDATE user_preferences[\s\S]*?= true/);
  });

  it('defaults to false on the client', () => {
    const store = readFileSync(join(ROOT, 'apps/mobile/src/state/app-store.tsx'), 'utf8');
    expect(store).toContain('showMedicationInNotifications: false');
  });

  it('is stored per user, alongside the other account preferences', () => {
    const sql = readFileSync(join(ROOT, 'db/migrations/0020_notification_privacy.sql'), 'utf8');
    expect(sql).toContain('ALTER TABLE user_preferences');
  });

  it('resolves a missing row to the private setting on the API too', () => {
    const src = readFileSync(join(ROOT, 'apps/api/src/routes/profiles.ts'), 'utf8');
    expect(src).toContain('showMedicationInNotifications: u.show_medication_in_notifications ?? false');
  });
});
