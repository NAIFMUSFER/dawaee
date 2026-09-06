import { t } from './i18n.js';
import type { MessageKey } from './i18n.js';
import type { Locale } from './enums.js';

/**
 * The text of a medication reminder, and the single place the privacy policy
 * for it is decided.
 *
 * Deliberately shared between the phone and the worker. The two used to build
 * their own bodies from their own template lookups, which meant a patient could
 * switch the setting off, watch their local notifications go generic, and still
 * be named by every push the server sent — a privacy control that appears to
 * work and does not. One function, called by both, makes that divergence a
 * compile error rather than a field report.
 *
 * DEFAULT IS PRIVATE. `showMedication` false — which is the column default, the
 * client default, and what a row predating the column resolves to — produces
 * text naming no drug and no dose.
 *
 * The private text is not empty of meaning. It still says a dose is due and at
 * what time, because the point of the reminder is that an elderly patient acts
 * on it, and "you have a notification" is not something anyone can act on. The
 * action buttons carry the rest: Taken, Snooze, Skip are unchanged in both
 * modes, so a confirmation from the lock screen still works without the name
 * ever being rendered.
 */

export interface ReminderTextInput {
  locale: Locale;
  /** The patient's explicit opt-in. Absent or false means private. */
  showMedication?: boolean;
  medicationName: string;
  /** Already formatted, e.g. "1 tablet". */
  doseText: string;
  /** Local time, e.g. "20:00". */
  time: string;
  /** Localized food instruction, or empty. */
  food?: string;
}

export interface ReminderText {
  title: string;
  body: string;
  /** The spoken line, when voice reminders are on. Never names a drug unless allowed. */
  voice: string;
  /** True when this text contains a medication name or dose. */
  containsMedicationDetail: boolean;
}

export function reminderText(input: ReminderTextInput): ReminderText {
  const { locale, medicationName, doseText, time, food } = input;
  const title = t(locale, 'reminder.title');

  if (!input.showMedication) {
    return {
      title,
      body: t(locale, 'reminder.bodyPrivate', { time }),
      // Voice follows the same flag rather than its own. Speaking the drug
      // name aloud in a room is a wider disclosure than printing it on a
      // screen, so it cannot be the looser of the two settings.
      voice: t(locale, 'reminder.voicePrivate'),
      containsMedicationDetail: false,
    };
  }

  const key: MessageKey = food ? 'reminder.bodyWithFood' : 'reminder.body';
  return {
    title,
    body: t(locale, key, { medication: medicationName, dose: doseText, time, food: food ?? '' }),
    voice: t(locale, 'reminder.voice', { medication: medicationName, dose: doseText, food: food ?? '' }),
    containsMedicationDetail: true,
  };
}

/**
 * The escalation text sent to a caregiver.
 *
 * Governed by the PATIENT's preference, not the caregiver's, because it is the
 * patient's medication being disclosed and the patient's choice to make. The
 * caregiver's own lock screen is outside this app's control either way, which
 * is the argument for defaulting it closed as well.
 */
export function caregiverMissedText(input: {
  locale: Locale;
  showMedication?: boolean;
  patientName: string;
  medicationName: string;
  time: string;
}): { body: string; containsMedicationDetail: boolean } {
  if (!input.showMedication) {
    return {
      body: t(input.locale, 'caregiver.missedAlertPrivate', {
        patient: input.patientName, time: input.time,
      }),
      containsMedicationDetail: false,
    };
  }
  return {
    body: t(input.locale, 'caregiver.missedAlert', {
      patient: input.patientName, medication: input.medicationName, time: input.time,
    }),
    containsMedicationDetail: true,
  };
}
