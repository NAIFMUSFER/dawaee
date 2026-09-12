import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
  deferred: () => { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error: unknown) => void };
  NetworkError: new (message?: string) => Error;
  ApiError: new (code: string) => Error;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/medication/edit.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');
const medicationId = 'medication-under-test';

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

function sharedOverride() {
  return {
    FOOD_INSTRUCTIONS: ['no_preference'],
    MEDICATION_FORMS: ['tablet'],
    STRENGTH_UNITS: ['mg'],
  };
}

describe('medication editor save mutation profile isolation', () => {
  it('late patient A edit completion cannot navigate patient B into patient A medication', async () => {
    const patchGate = deferred();
    const navigations: string[] = [];
    let getCount = 0;
    const h = createHarness(screen, hook, {}, {
      'expo-router': {
        useLocalSearchParams: () => ({ mode: 'edit', id: medicationId }),
        router: {
          back: () => undefined,
          push: () => undefined,
          replace: (route: string) => { navigations.push(route); },
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
          get: async () => ({ medication: medication(getCount++ === 0 ? 'A' : 'B') }),
          patch: async () => patchGate.promise,
          post: async () => undefined,
        },
      },
      '@dawaee/shared': sharedOverride(),
    });

    try {
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');

      const save = h.find('Button', (props: any) => props.testID === 'save-medication');
      expect(save).not.toBeNull();
      save.onPress();
      await h.flush();

      h.switchProfile('B');
      await h.flush();
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');

      patchGate.resolve({});
      await h.flush();

      expect(navigations).toEqual([]);
    } finally {
      h.unmount();
    }
  });
});
