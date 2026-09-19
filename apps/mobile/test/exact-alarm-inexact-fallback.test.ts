import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { loadModule, dose } = require('./notification-schedule-races.cjs') as {
  loadModule: (file: string, platform?: string) => {
    api: {
      rescheduleLocalNotifications: (
        doses: unknown[],
        locale: string,
      ) => Promise<{ scheduled: number; failed: number; exactAlarmsUnavailable: boolean }>;
    };
    state: { exactAlarmsAllowed: boolean; scheduledCalls: unknown[] };
  };
  dose: (id: string, minutes?: number) => unknown;
};

describe('Android inexact fallback disclosure', () => {
  it('reports exact-alarm degradation even when Expo accepts an inexact fallback schedule', async () => {
    const file = fileURLToPath(new URL('../src/notifications/index.ts', import.meta.url));
    const { api, state } = loadModule(file, 'android');
    state.exactAlarmsAllowed = false;

    const result = await api.rescheduleLocalNotifications([dose('A')], 'en');

    expect(result.scheduled).toBe(1);
    expect(result.failed).toBe(0);
    expect(state.scheduledCalls).toHaveLength(1);
    expect(result.exactAlarmsUnavailable).toBe(true);
  });
});
