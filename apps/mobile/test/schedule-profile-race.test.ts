import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/medication/schedule.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');
const medicationId = 'medication-under-test';
const scheduleId = 'schedule-under-test';

function overrides() {
  return {
    'expo-router': {
      useLocalSearchParams: () => ({}),
      router: { back: () => undefined, push: () => undefined, replace: () => undefined },
    },
    '@/navigation/private-navigation': {
      getMedicationScheduleRouteIntent: (userId: string, patientProfileId: string) => ({
        userId, patientProfileId, medicationId, mode: 'edit', scheduleId,
      }),
      setMedicationDetailRouteIntent: () => undefined,
      setMedicationScheduleRouteIntent: () => undefined,
    },
    '@/components/DateField': {
      DateField: 'DateField',
      isValidLocalDate: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value),
      todayLocalDate: () => '2026-09-11',
    },
    '@dawaee/shared': {
      DOSE_UNITS: ['tablet'],
      SCHEDULE_RULE_KINDS: ['fixed_times', 'interval', 'days_of_week', 'cycle', 'as_needed'],
    },
  };
}

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

function answer(request: any, label: string) {
  request.completed = true;
  request.resolve({ schedules: [schedule(label)] });
}

describe('schedule editor profile isolation', () => {
  it('does not render patient A schedule state on the first patient B frame', async () => {
    const h = createHarness(screen, hook, {}, overrides());

    try {
      const [patientA] = h.batch();
      expect(patientA?.route).toBe(`/v1/medications/${medicationId}`);
      answer(patientA, 'A');
      await h.flush();
      expect(h.text()).toContain('06:13');
      expect(h.text()).toContain('91');

      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('06:13');
      expect(h.text()).not.toContain('91');
    } finally {
      h.unmount();
    }
  });

  it('drops patient A schedule hydration that resolves after switching to patient B', async () => {
    const h = createHarness(screen, hook, {}, overrides());

    try {
      const [patientA] = h.batch();
      expect(patientA?.route).toBe(`/v1/medications/${medicationId}`);

      h.switchProfile('B', false);
      answer(patientA, 'A');
      await h.flush();

      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('06:13');
      expect(h.text()).not.toContain('91');
    } finally {
      h.unmount();
    }
  });
});
