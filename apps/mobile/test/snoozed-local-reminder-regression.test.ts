import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { loadModule, dose } = require('./notification-schedule-races.cjs') as {
  loadModule: (file: string, platform?: string) => {
    api: {
      rescheduleLocalNotifications: (
        doses: Array<Record<string, unknown>>,
        locale: string,
      ) => Promise<{ scheduled: number; failed: number }>;
    };
    state: { active: Array<{ trigger: { date: Date | string } }> };
  };
  dose: (id: string, minutes?: number) => Record<string, unknown>;
};

describe('snoozed local medication reminders', () => {
  const file = fileURLToPath(new URL('../src/notifications/index.ts', import.meta.url));

  it('uses snoozedUntil as the native trigger instead of the original dose time', async () => {
    const { api, state } = loadModule(file, 'ios');
    const snoozedUntil = new Date(Date.now() + 15 * 60_000).toISOString();
    const snoozedDose = {
      ...dose('SNOOZED', -5),
      status: 'snoozed',
      snoozedUntil,
      scheduledTimezone: 'Asia/Riyadh',
    };

    const result = await api.rescheduleLocalNotifications([snoozedDose], 'en');

    assert.equal(result.failed, 0);
    assert.equal(result.scheduled, 1, 'a snoozed dose lost its local reminder because the original time was already past');
    assert.equal(state.active.length, 1);
    assert.equal(new Date(state.active[0]!.trigger.date).toISOString(), snoozedUntil);
  });
});
