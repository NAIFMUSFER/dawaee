import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupedReminderText } from '../src/reminder-text.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const MEDS = [
  { name: 'Medicine A', doseText: '1 tablet' },
  { name: 'Medicine B', doseText: '2 tablets' },
  { name: 'Medicine C', doseText: '5 ml' },
];

describe('simultaneous dose reminder text', () => {
  it('is private by default but still tells the patient how many medicines are due', () => {
    const text = groupedReminderText({ locale: 'en', time: '08:00', medications: MEDS });
    expect(text.body).toContain('3');
    expect(text.body).toContain('08:00');
    expect(text.body).not.toContain('Medicine A');
    expect(text.body).not.toContain('1 tablet');
    expect(text.containsMedicationDetail).toBe(false);
  });

  it('shows medicine details only after explicit opt-in', () => {
    const text = groupedReminderText({
      locale: 'en', showMedication: true, time: '08:00', medications: MEDS,
    });
    expect(text.body).toContain('Medicine A');
    expect(text.body).toContain('1 tablet');
    expect(text.containsMedicationDetail).toBe(true);
  });

  it('does not attach single-dose actions to grouped local alerts', () => {
    const mobile = readFileSync(join(ROOT, 'apps/mobile/src/notifications/index.ts'), 'utf8');
    expect(mobile).toContain("kind: 'dose_group_reminder'");
    expect(mobile).toContain("...(grouped ? {} : { categoryIdentifier: MEDICATION_CATEGORY_ID })");
  });

  it('deduplicates the same occurrence before deciding that a reminder is a group', () => {
    const mobile = readFileSync(join(ROOT, 'apps/mobile/src/notifications/index.ts'), 'utf8');
    expect(mobile).toContain('const seenDoseIds = new Set<string>()');
    expect(mobile).toContain('if (seenDoseIds.has(dose.id)) continue');
    expect(mobile).toContain('seenDoseIds.add(dose.id)');
  });

  it('consumes handled cold-start actions so an old Snooze is not replayed on a later app launch', () => {
    const mobile = readFileSync(join(ROOT, 'apps/mobile/src/notifications/index.ts'), 'utf8');
    expect(mobile).toContain('if (outcome) {');
    expect(mobile).toContain('clearLastNotificationResponseAsync');
  });

  it('routes a grouped notification tap to Today instead of leaving the patient on an unrelated screen', () => {
    const layout = readFileSync(join(ROOT, 'apps/mobile/app/_layout.tsx'), 'utf8');
    const listener = readFileSync(join(ROOT, 'apps/mobile/src/notifications/grouped-navigation.ts'), 'utf8');
    // The Shell owns the fixed route; validation and consumption moved into
    // the injectable helper. Keep both sides of this wiring contract covered.
    // Runtime lifecycle coverage also lives in grouped-push-navigation.test.ts
    // and caregiver-push-navigation.test.ts, which executes the actual Shell.
    expect(layout).toContain("import { startGroupedNotificationListener } from '@/notifications/grouped-navigation';");
    expect(layout).toMatch(
      /stop = startGroupedNotificationListener\(\s*native,\s*\(\) => router\.replace\('\/\(tabs\)\/today'\),\s*isCurrent,\s*\)/,
    );
    expect(listener).toContain('response.actionIdentifier !== defaultAction');
    expect(listener).toContain("content.data.kind !== 'dose_group_reminder'");
    expect(listener).toContain('if (groupedResponseKey(latest, native.DEFAULT_ACTION_IDENTIFIER) !== key) return;');
    expect(listener).toContain('await native.clearLastNotificationResponseAsync();');
  });

  it('groups the first server reminder and disables its single-dose category', () => {
    const worker = readFileSync(join(ROOT, 'apps/worker/src/jobs/reminders.ts'), 'utf8');
    const dispatcher = readFileSync(join(ROOT, 'apps/worker/src/jobs/dispatcher.ts'), 'utf8');
    expect(worker).toContain('initialPatientGroupsDispatched');
    expect(worker).toContain('groupedReminderText({');
    expect(dispatcher).toContain("grouped ? 'dose_group_reminder' : row.kind");
    expect(dispatcher).toContain("row.kind.startsWith('dose_reminder') && !grouped");
  });
});
