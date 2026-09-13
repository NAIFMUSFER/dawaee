import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
  deferred: () => { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error: unknown) => void };
  NetworkError: new (message?: string) => Error;
  ApiError: new (code: string) => Error;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/medication/stock.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');
const medicationId = 'medication-under-test';

function deferredApi() {
  const calls: Array<{ route: string; gate: ReturnType<typeof deferred> }> = [];
  const get = (route: string) => {
    const gate = deferred();
    calls.push({ route, gate });
    return gate.promise;
  };
  return { calls, get };
}

function overrides(io: ReturnType<typeof deferredApi>) {
  return {
    'expo-router': {
      useLocalSearchParams: () => ({}),
      router: { back: () => undefined, push: () => undefined, replace: () => undefined },
    },
    '@/navigation/private-navigation': {
      getMedicationStockRouteIntent: (userId: string, patientProfileId: string) => ({
        userId, patientProfileId, medicationId,
      }),
      setMedicationStockRouteIntent: () => undefined,
    },
    '@/components/DateField': {
      todayLocalDate: () => '2026-09-11',
    },
    '@/storage/low-stock-snooze': {
      readSnooze: async () => null,
      clearSnooze: async () => undefined,
      setSnooze: async () => undefined,
    },
    '@/api/client': {
      NetworkError,
      ApiError,
      api: {
        get: io.get,
        put: async () => ({}),
        post: async () => ({}),
      },
    },
    '@dawaee/shared': {
      DOSE_UNITS: ['tablet'],
    },
  };
}

function resolveLoad(calls: Array<{ route: string; gate: ReturnType<typeof deferred> }>, label: string) {
  for (const call of calls) {
    if (call.route === `/v1/medications/${medicationId}/stock`) {
      call.gate.resolve({
        stock: {
          unit: 'tablet',
          initialQuantity: 30,
          remainingQuantity: 12,
          trackingEnabled: true,
          lowStockThresholdDays: 7,
          lastRefillAt: null,
        },
        forecast: { remainingQuantity: 12, daysRemaining: 12, runoutDate: null, isLow: false },
        transactions: [],
        refills: [],
      });
    } else if (call.route === `/v1/medications/${medicationId}`) {
      call.gate.resolve({ medication: { name: `SYNTHETIC-${label}-ONLY` } });
    } else {
      throw new Error(`unexpected request ${call.route}`);
    }
  }
}

describe('stock screen profile isolation', () => {
  it('does not render patient A stock data on the first patient B frame', async () => {
    const io = deferredApi();
    const h = createHarness(screen, hook, {}, overrides(io));

    try {
      expect(io.calls).toHaveLength(2);
      resolveLoad(io.calls, 'A');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');

      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });

  it('drops a patient A stock response that resolves after switching to patient B', async () => {
    const io = deferredApi();
    const h = createHarness(screen, hook, {}, overrides(io));

    try {
      const patientA = [...io.calls];
      expect(patientA).toHaveLength(2);

      h.switchProfile('B', false);
      resolveLoad(patientA, 'A');
      await h.flush();

      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });
});
