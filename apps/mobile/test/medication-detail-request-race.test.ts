import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (
    file: string,
    hookFile?: string,
    profile?: Record<string, unknown>,
    overrides?: Record<string, unknown>,
  ) => {
    batch: () => Array<{ route: string; completed?: boolean; resolve: (value: unknown) => void }>;
    flush: () => Promise<void>;
    find: (type: string, predicate?: (props: Record<string, unknown>) => boolean) => Record<string, any> | null;
    text: () => string;
    unmount: () => void;
  };
};

function answer(batch: Array<{ route: string; completed?: boolean; resolve: (value: unknown) => void }>, label: string) {
  for (const request of batch) {
    request.completed = true;
    if (request.route === '/v1/medications/audit-medication') {
      request.resolve({
        medication: {
          id: 'audit-medication',
          name: `SYNTHETIC-${label}-ONLY`,
          form: 'tablet',
          strengthValue: null,
          strengthUnit: null,
          manufacturer: null,
          barcode: null,
          status: 'active',
          imageKey: null,
          foodInstruction: 'none',
          instructions: null,
          startDate: '2026-09-01',
          endDate: null,
          source: 'manual',
          sourceVerified: true,
          notes: null,
        },
        schedules: [],
      });
    } else if (request.route === '/v1/medications/audit-medication/stock') {
      request.resolve({ stock: null, forecast: null });
    } else if (request.route === '/v1/doses') {
      request.resolve({ doses: [] });
    } else {
      throw new Error(`unexpected medication-detail request: ${request.route}`);
    }
  }
}

describe('medication detail request boundary', () => {
  it('the newest same-medication refresh wins when responses complete out of order', async () => {
    const screen = fileURLToPath(new URL('../app/medication/[id].tsx', import.meta.url));
    const h = createHarness(screen, undefined, undefined, {
      'expo-router': {
        router: { push: () => undefined, replace: () => undefined, back: () => undefined },
        useLocalSearchParams: () => ({ id: 'audit-medication' }),
      },
      '@/theme': {
        statusColors: new Proxy({}, { get: () => ({ fg: '#000', bg: '#fff' }) }),
      },
    });

    try {
      answer(h.batch(), 'INITIAL');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-INITIAL-ONLY');

      const refresh = h.find('RefreshControl');
      expect(refresh).not.toBeNull();
      refresh!.onRefresh();
      const older = h.batch();
      expect(older.length).toBeGreaterThan(0);

      refresh!.onRefresh();
      const newer = h.batch().filter((request) => !older.includes(request));
      expect(newer.length).toBeGreaterThan(0);

      answer(newer, 'NEWER');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-NEWER-ONLY');

      answer(older, 'OLDER');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-NEWER-ONLY');
      expect(h.text()).not.toContain('SYNTHETIC-OLDER-ONLY');
    } finally {
      h.unmount();
    }
  });
});
