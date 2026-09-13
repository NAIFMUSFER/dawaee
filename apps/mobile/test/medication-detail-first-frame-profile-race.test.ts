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

function deferredApi() {
  const calls: Array<{ route: string; query?: unknown; gate: ReturnType<typeof deferred> }> = [];
  const get = (route: string, query?: unknown) => {
    const gate = deferred();
    calls.push({ route, query, gate });
    return gate.promise;
  };
  return { calls, get };
}

function resolveInitialLoad(calls: Array<{ route: string; gate: ReturnType<typeof deferred> }>, label: string) {
  for (const call of calls) {
    if (call.route === `/v1/medications/${medicationId}`) {
      call.gate.resolve({
        medication: {
          id: medicationId,
          name: `SYNTHETIC-${label}-ONLY`,
          status: 'active',
          imageKey: null,
        },
        schedules: [],
      });
    } else if (call.route === `/v1/medications/${medicationId}/stock`) {
      call.gate.resolve(null);
    } else if (call.route === '/v1/doses') {
      call.gate.resolve({ doses: [] });
    } else {
      throw new Error(`unexpected request ${call.route}`);
    }
  }
}

describe('medication detail first-frame profile isolation', () => {
  it('does not render patient A medication data on the first patient B frame', async () => {
    const io = deferredApi();
    const h = createHarness(screen, hook, {}, {
      'expo-router': {
        router: { back: () => undefined, push: () => undefined, replace: () => undefined },
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
        api: { get: io.get },
      },
    });

    try {
      expect(io.calls).toHaveLength(3);
      resolveInitialLoad(io.calls, 'A');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');

      // Switch the active patient and inspect that render before B's passive
      // loading effect runs. A request fence can stop future writes, but it
      // cannot erase already-rendered A state unless the clinical view remounts.
      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });
});
