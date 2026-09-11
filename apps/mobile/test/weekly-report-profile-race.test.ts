import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
  deferred: () => { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error: unknown) => void };
  NetworkError: new (message?: string) => Error;
  ApiError: new (code: string) => Error;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/reports/weekly.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

function report(label: string) {
  const summary = {
    from: '2026-09-01', to: '2026-09-07', scheduled: 1, taken: 1,
    takenOnTime: 1, takenLate: 0, skipped: 0, missed: 0, pending: 0,
    adherencePercent: 100,
  };
  return {
    meta: {
      patientName: `SYNTHETIC-${label}-ONLY`,
      timezone: 'Asia/Riyadh',
      from: summary.from,
      to: summary.to,
      generatedAt: '2026-09-07T12:00:00Z',
      audience: 'family',
    },
    summary,
    daily: [{ date: '2026-09-07', scheduled: 1, taken: 1, missed: 0, adherencePercent: 100 }],
    medications: [{ name: `SYNTHETIC-${label}-ONLY`, strength: null, form: 'tablet', summary }],
    stockOutlook: [],
  };
}

function harness() {
  const a = deferred();
  const b = deferred();
  const requests: string[] = [];
  const h = createHarness(screen, hook, {}, {
    '@/api/client': {
      NetworkError,
      ApiError,
      api: {
        get: async (route: string, query?: { profileId?: string }) => {
          if (route !== '/v1/reports/weekly') throw new Error(`unexpected request ${route}`);
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

describe('weekly family report profile isolation', () => {
  it('clears patient A report before the first patient B paint', async () => {
    const { h, a } = harness();
    try {
      await h.flush();
      a.resolve(report('A'));
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');

      h.switchProfile('B', false);

      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });

  it('ignores a late patient A response after patient B has loaded', async () => {
    const { h, a, b, requests } = harness();
    try {
      await h.flush();
      expect(requests).toEqual(['A']);

      h.switchProfile('B');
      await h.flush();
      expect(requests).toEqual(['A', 'B']);

      b.resolve(report('B'));
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');

      a.resolve(report('A'));
      await h.flush();

      expect(h.text()).toContain('SYNTHETIC-B-ONLY');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });
});
