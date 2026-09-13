import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
  deferred: () => { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error: unknown) => void };
  NetworkError: new (message?: string) => Error;
  ApiError: new (code: string) => Error;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/medication/detail.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');
const medicationId = 'medication-under-test';

function medication(label: string) {
  return {
    id: medicationId,
    patientProfileId: label,
    name: `SYNTHETIC-${label}-ONLY`,
    status: 'active',
    imageKey: null,
  };
}

function harness() {
  const deleteGate = deferred();
  const patchGate = deferred();
  const replacements: string[] = [];
  let medicationLoads = 0;
  const h = createHarness(screen, hook, {}, {
    'expo-router': {
      router: {
        back: () => undefined,
        push: () => undefined,
        replace: (route: string) => { replacements.push(route); },
      },
    },
    '@/navigation/private-navigation': {
      getMedicationDetailRouteIntent: (userId: string, patientProfileId: string) => ({
        userId, patientProfileId, medicationId,
      }),
    },
    '@/components/MedicationDetailView': {
      MedicationDetailView: 'MedicationDetailView',
    },
    '@/api/client': {
      NetworkError,
      ApiError,
      api: {
        get: async (route: string) => {
          if (route === `/v1/medications/${medicationId}`) {
            return { medication: medication(medicationLoads++ === 0 ? 'A' : 'B'), schedules: [] };
          }
          if (route === `/v1/medications/${medicationId}/stock`) return null;
          if (route === '/v1/doses') return { doses: [] };
          throw new Error(`unexpected request ${route}`);
        },
        patch: async () => patchGate.promise,
        delete: async () => deleteGate.promise,
      },
    },
  });
  return { h, deleteGate, patchGate, replacements };
}

describe('medication detail mutation profile isolation', () => {
  it('late patient A delete completion cannot navigate the already-switched patient B UI', async () => {
    const { h, deleteGate, replacements } = harness();
    try {
      await h.flush();
      const detail = h.find('MedicationDetailView');
      expect(detail).not.toBeNull();
      detail.onRemove(true);
      await h.flush();

      h.switchProfile('B');
      await h.flush();
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');

      deleteGate.resolve({});
      await h.flush();

      expect(replacements).not.toContain('/(tabs)/medications');
    } finally {
      h.unmount();
    }
  });

  it('late patient A archive completion cannot navigate the already-switched patient B UI', async () => {
    const { h, patchGate, replacements } = harness();
    try {
      await h.flush();
      const detail = h.find('MedicationDetailView');
      expect(detail).not.toBeNull();
      detail.onSetStatus('archived');
      await h.flush();

      h.switchProfile('B');
      await h.flush();
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');

      patchGate.resolve({});
      await h.flush();

      expect(replacements).not.toContain('/(tabs)/medications');
    } finally {
      h.unmount();
    }
  });
});
