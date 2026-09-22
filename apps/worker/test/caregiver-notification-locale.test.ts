import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const remindersSource = readFileSync(
  fileURLToPath(new URL('../src/jobs/reminders.ts', import.meta.url)),
  'utf8',
);

describe('caregiver notification locale wiring', () => {
  it('loads the linked caregiver locale and uses it instead of the patient locale', () => {
    expect(remindersSource).toContain("COALESCE(u.locale, 'ar') AS caregiver_locale");
    expect(remindersSource).toContain("locale: r.caregiver_locale === 'en' ? 'en' : 'ar'");
    expect(remindersSource).toContain('isPatient ? dose.patient_locale : recipient.locale');
  });
});
