import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/medication/edit.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');
const medicationId = 'medication-under-test';

function overrides() {
  return {
    'expo-router': {
      useLocalSearchParams: () => ({ mode: 'edit', id: medicationId }),
      router: { back: () => undefined, push: () => undefined, replace: () => undefined },
    },
    '@/components/DateField': {
      DateField: 'DateField',
      isValidLocalDate: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value),
      todayLocalDate: () => '2026-09-11',
    },
    '@dawaee/shared': {
      FOOD_INSTRUCTIONS: ['no_preference'],
      MEDICATION_FORMS: ['tablet'],
      STRENGTH_UNITS: ['mg'],
    },
  };
}

function medication(label: string) {
  return {
    id: medicationId,
    patientProfileId: label,
    name: `SYNTHETIC-${label}-ONLY`,
    brandName: null,
    genericName: null,
    form: 'tablet',
    strengthValue: label === 'A' ? 91 : 12,
    strengthUnit: 'mg',
    instructions: null,
    doctorInstructions: null,
    foodInstruction: 'no_preference',
    notes: null,
    startDate: '2026-09-01',
    endDate: null,
    expiryDate: null,
  };
}

function answer(request: any, label: string) {
  request.completed = true;
  request.resolve({ medication: medication(label) });
}

describe('medication editor profile isolation', () => {
  it('does not render patient A draft on the first patient B frame', async () => {
    const h = createHarness(screen, hook, {}, overrides());

    try {
      const [patientA] = h.batch();
      expect(patientA?.route).toBe(`/v1/medications/${medicationId}`);
      answer(patientA, 'A');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');
      expect(h.text()).toContain('91');

      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
      expect(h.text()).not.toContain('91');
    } finally {
      h.unmount();
    }
  });

  it('drops patient A medication hydration that resolves after switching to patient B', async () => {
    const h = createHarness(screen, hook, {}, overrides());

    try {
      const [patientA] = h.batch();
      expect(patientA?.route).toBe(`/v1/medications/${medicationId}`);

      h.switchProfile('B', false);
      answer(patientA, 'A');
      await h.flush();

      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
      expect(h.text()).not.toContain('91');
    } finally {
      h.unmount();
    }
  });
});
