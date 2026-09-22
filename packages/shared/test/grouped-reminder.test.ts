import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

  it('consumes handled cold-start actions so an old Snooze is not replayed on a later app launch', async () => {
    const { loadModule, flush } = createRequire(import.meta.url)(join(ROOT, 'apps/mobile/test/notification-schedule-races.cjs')) as {
      loadModule: (file: string) => {
        api: { startNotificationActionListener: () => Promise<() => void> };
        state: { lastResponse: unknown; action: () => Promise<unknown>; actionCalls: number; responseClears: number };
      };
      flush: () => Promise<void>;
    };
    const { api, state } = loadModule(join(ROOT, 'apps/mobile/src/notifications/index.ts'));
    state.lastResponse = { actionIdentifier: 'SNOOZE', notification: { date: 123,
      request: { identifier: 'cold-start-snooze', content: { data: { doseId: 'synthetic-dose' } } } } };
    state.action = async () => ({ action: 'snooze', doseId: 'synthetic-dose', synced: true });
    const stop = await api.startNotificationActionListener();
    await flush();
    expect(state.actionCalls).toBe(1);
    expect(state.responseClears).toBe(1);
    expect(state.lastResponse).toBeNull();
    stop();
    const stopRestarted = await api.startNotificationActionListener();
    await flush();
    expect(state.actionCalls).toBe(1);
    stopRestarted();
  });

  it('resolves the notification patient before opening their Today screen', () => {
    const layout = readFileSync(join(ROOT, 'apps/mobile/app/_layout.tsx'), 'utf8');
    const landing = readFileSync(join(ROOT, 'apps/mobile/app/notification.tsx'), 'utf8');
    const listener = readFileSync(join(ROOT, 'apps/mobile/src/notifications/grouped-navigation.ts'), 'utf8');
    // The Shell owns the fixed route; validation and consumption moved into
    // the injectable helper. Keep both sides of this wiring contract covered.
    // Runtime lifecycle coverage also lives in grouped-push-navigation.test.ts
    // and caregiver-push-navigation.test.ts, which executes the actual Shell.
    expect(layout).toContain("import { startGroupedNotificationListener } from '@/notifications/grouped-navigation';");
    expect(layout).toContain('setPatientReminderIntent(user.id, { doseId })');
    expect(layout).toContain("router.replace('/notification')");
    expect(landing).toContain('setActiveProfile(selected.profileId)');
    expect(landing).toContain("router.replace('/(tabs)/today')");
    expect(listener).toContain('response.actionIdentifier !== defaultAction');
    expect(listener).toContain("'dose_group_reminder'");
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
