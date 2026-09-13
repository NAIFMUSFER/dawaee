import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
  deferred: () => { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error: unknown) => void };
  NetworkError: new (message?: string) => Error;
  ApiError: new (code: string) => Error;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/reports/clinician.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

const testTheme = {
  colors: new Proxy({}, { get: () => '#000' }),
  spacing: new Proxy({}, { get: () => 4 }),
  radius: new Proxy({}, { get: () => 4 }),
  touch: 44,
};

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

function report(label: string) {
  const summary = {
    from: '2026-09-01', to: '2026-09-07', scheduled: 1, taken: 1,
    takenOnTime: 1, takenLate: 0, skipped: 0, missed: 0, pending: 0,
    adherencePercent: 100,
  };
  return {
    meta: {
      patientName: `Patient ${label}`,
      timezone: 'Asia/Riyadh',
      from: summary.from,
      to: summary.to,
      generatedAt: '2026-09-07T12:00:00Z',
      audience: 'clinician',
    },
    summary,
    medications: [{ name: `SYNTHETIC-${label}-ONLY`, strength: null, form: 'tablet', summary }],
    doses: [],
  };
}

function medicationList(label: string) {
  return {
    medications: [{
      id: `med-${label}`,
      name: `SYNTHETIC-${label}-ONLY`,
      form: 'tablet',
      strengthValue: null,
      strengthUnit: null,
      status: 'active',
      schedules: [],
    }],
  };
}

function harness() {
  const gates = {
    A: { report: deferred(), medications: deferred() },
    B: { report: deferred(), medications: deferred() },
  } as const;
  const requests: Array<{ route: string; profileId: string }> = [];
  const h = createHarness(screen, hook, {}, {
    'expo-router': {
      router: { back: () => undefined },
      useLocalSearchParams: () => ({ from: '2026-09-01', to: '2026-09-07' }),
    },
    '@/hooks/useTheme': { useTheme: () => testTheme },
    '@dawaee/core': { addDays, daysBetween },
    '@/api/client': {
      NetworkError,
      ApiError,
      api: {
        get: async (route: string, query?: { profileId?: string }) => {
          const profileId = query?.profileId ?? 'missing';
          requests.push({ route, profileId });
          if (profileId !== 'A' && profileId !== 'B') throw new Error(`unexpected profile ${profileId}`);
          if (route === '/v1/reports/clinician') return gates[profileId].report.promise;
          if (route === '/v1/medications') return gates[profileId].medications.promise;
          throw new Error(`unexpected request ${route}`);
        },
      },
    },
  });
  return { h, gates, requests };
}

function resolveProfile(gates: ReturnType<typeof harness>['gates'], label: 'A' | 'B') {
  gates[label].report.resolve(report(label));
  gates[label].medications.resolve(medicationList(label));
}

describe('clinician report profile isolation', () => {
  it('does not retain patient A report on the first patient B paint', async () => {
    const { h, gates } = harness();
    try {
      await h.flush();
      resolveProfile(gates, 'A');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');

      h.switchProfile('B', false);

      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });

  it('autoloads patient B and ignores a late patient A completion after profile switch', async () => {
    const { h, gates, requests } = harness();
    try {
      await h.flush();
      expect(requests.filter((request) => request.profileId === 'A')).toHaveLength(2);

      h.switchProfile('B');
      await h.flush();
      expect(requests.filter((request) => request.profileId === 'B')).toHaveLength(2);

      resolveProfile(gates, 'B');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');

      resolveProfile(gates, 'A');
      await h.flush();

      expect(h.text()).toContain('SYNTHETIC-B-ONLY');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });
});
