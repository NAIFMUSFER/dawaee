import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
  deferred: () => { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error: unknown) => void };
  NetworkError: new (message?: string) => Error;
  ApiError: new (code: string) => Error;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/reports/adherence.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

const testTheme = {
  colors: new Proxy({}, { get: () => '#000' }),
  spacing: new Proxy({}, { get: () => 4 }),
  radius: new Proxy({}, { get: () => 4 }),
  touch: 44,
};

function response(label: string) {
  return {
    profileId: label,
    summary: {
      from: '2026-09-01',
      to: '2026-09-07',
      scheduled: 1,
      taken: 1,
      takenOnTime: 1,
      takenLate: 0,
      missed: 0,
      adherencePercent: 100,
    },
    daily: [{
      date: '2026-09-07',
      scheduled: 1,
      taken: 1,
      takenOnTime: 1,
      takenLate: 0,
      missed: 0,
      adherencePercent: 100,
    }],
    byMedicationWithheld: false,
    byMedication: [{
      medicationId: `med-${label}`,
      medicationName: `SYNTHETIC-${label}-ONLY`,
      summary: {
        scheduled: 1,
        taken: 1,
        takenOnTime: 1,
        takenLate: 0,
        missed: 0,
        adherencePercent: 100,
      },
    }],
  };
}

function harness() {
  const a = deferred();
  const b = deferred();
  const requests: string[] = [];
  const h = createHarness(screen, hook, {}, {
    '@/hooks/useTheme': { useTheme: () => testTheme },
    '@/api/client': {
      NetworkError,
      ApiError,
      api: {
        get: async (route: string, query?: { profileId?: string }) => {
          if (route !== '/v1/adherence') throw new Error(`unexpected request ${route}`);
          const profileId = query?.profileId ?? 'missing';
          requests.push(profileId);
          if (profileId === 'A') return a.promise;
          if (profileId === 'B') return b.promise;
          throw new Error(`unexpected profile ${profileId}`);
        },
      },
    },
  });
  return { h, a, b, requests };
}

describe('adherence report profile isolation', () => {
  it('does not render patient A adherence during the first patient B render', async () => {
    const { h, a } = harness();
    try {
      await h.flush();
      a.resolve(response('A'));
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');

      h.switchProfile('B', false);

      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });

  it('late patient A completion cannot overwrite an already-loaded patient B report', async () => {
    const { h, a, b, requests } = harness();
    try {
      await h.flush();
      expect(requests).toEqual(['A']);

      h.switchProfile('B');
      await h.flush();
      expect(requests).toEqual(['A', 'B']);

      b.resolve(response('B'));
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');

      a.resolve(response('A'));
      await h.flush();

      expect(h.text()).toContain('SYNTHETIC-B-ONLY');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });
});
