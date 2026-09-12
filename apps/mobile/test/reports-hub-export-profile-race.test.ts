import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
  deferred: () => { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error: unknown) => void };
  NetworkError: new (message?: string) => Error;
  ApiError: new (code: string) => Error;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/reports/index.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

function exportResponse(profileId: string, withMedications: boolean) {
  return {
    exportedAt: '2026-09-11T03:00:00Z',
    profileId,
    data: withMedications ? { medications: [{ id: `SYNTHETIC-${profileId}-ONLY` }] } : {},
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
          if (route !== '/v1/reports/export') throw new Error(`unexpected request ${route}`);
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

describe('reports hub export profile isolation', () => {
  it('clears patient A export metadata before the first patient B paint', async () => {
    const { h, a, requests } = harness();
    try {
      const prepare = h.find('Button', (props: any) => props.label === 'reports.prepareExport');
      expect(prepare).toBeTruthy();
      prepare.onPress();
      await h.flush();
      expect(requests).toEqual(['A']);

      a.resolve(exportResponse('A', true));
      await h.flush();
      expect(h.text()).toContain('export.medications');

      h.switchProfile('B', false);

      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('export.medications');
      expect(h.text()).not.toContain('reports.exportReady');
    } finally {
      h.unmount();
    }
  });

  it('ignores a late patient A export response after switching to patient B', async () => {
    const { h, a, requests } = harness();
    try {
      const prepare = h.find('Button', (props: any) => props.label === 'reports.prepareExport');
      expect(prepare).toBeTruthy();
      prepare.onPress();
      await h.flush();
      expect(requests).toEqual(['A']);

      h.switchProfile('B');
      await h.flush();
      expect(h.app.activeProfile.id).toBe('B');

      a.resolve(exportResponse('A', true));
      await h.flush();

      expect(h.text()).not.toContain('export.medications');
      expect(h.text()).not.toContain('reports.exportReady');
    } finally {
      h.unmount();
    }
  });
});
