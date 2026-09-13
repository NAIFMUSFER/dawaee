import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
  deferred: () => { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error: unknown) => void };
  NetworkError: new (message?: string) => Error;
  ApiError: new (code: string) => Error;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/medication/schedule.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');
const medicationId = 'medication-under-test';
const scheduleId = 'schedule-under-test';

function schedule(label: string) {
  return {
    id: scheduleId,
    rule: { kind: 'fixed_times', times: [label === 'A' ? '06:13' : '19:47'] },
    ruleKind: 'fixed_times',
    doseQuantity: label === 'A' ? 91 : 12,
    doseUnit: 'tablet',
    timezone: 'Asia/Riyadh',
    startDate: '2026-09-01',
    endDate: null,
    missedAfterMinutes: 120,
    lateAfterMinutes: 30,
    active: true,
  };
}

describe('schedule save mutation profile isolation', () => {
  it('late patient A schedule save cannot navigate the already-switched patient B UI', async () => {
    const patchGate = deferred();
    const replacements: string[] = [];
    let getCount = 0;
    const h = createHarness(screen, hook, {}, {
      'expo-router': {
        useLocalSearchParams: () => ({ medicationId, mode: 'edit', scheduleId }),
        router: {
          back: () => undefined,
          push: () => undefined,
          replace: (route: string) => { replacements.push(route); },
        },
      },
      '@/components/DateField': {
        DateField: 'DateField',
        isValidLocalDate: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value),
        todayLocalDate: () => '2026-09-11',
      },
      '@/api/client': {
        NetworkError,
        ApiError,
        api: {
          get: async () => ({ schedules: [schedule(getCount++ === 0 ? 'A' : 'B')] }),
          patch: async () => patchGate.promise,
          post: async () => undefined,
        },
      },
      '@dawaee/shared': {
        DOSE_UNITS: ['tablet'],
        SCHEDULE_RULE_KINDS: ['fixed_times', 'interval', 'days_of_week', 'cycle', 'as_needed'],
      },
    });

    try {
      await h.flush();
      expect(h.text()).toContain('06:13');

      const save = h.find('Button', (props: any) => props.testID === 'save-schedule');
      expect(save).not.toBeNull();
      save.onPress();
      await h.flush();

      h.switchProfile('B');
      await h.flush();
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).toContain('19:47');

      patchGate.resolve({});
      await h.flush();

      expect(replacements).not.toContain('/medication/detail');
    } finally {
      h.unmount();
    }
  });
});
