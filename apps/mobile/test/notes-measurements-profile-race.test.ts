import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/reports/notes.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

const theme = {
  colors: new Proxy({}, { get: () => '#000' }),
  spacing: new Proxy({}, { get: () => 4 }),
  radius: new Proxy({}, { get: () => 8 }),
  font: new Proxy({}, { get: () => 16 }),
  hairline: 1,
  touch: 44,
  elderlyMode: false,
  lineHeight: (value: number) => value * 1.4,
};

const shared = {
  SYMPTOM_TAGS: ['headache'],
  errorMessageKey: (code: string) => `error.${code}`,
};

function note(label: string) {
  return {
    id: `note-${label}`,
    tags: ['headache'],
    text: `SYNTHETIC-${label}-NOTE`,
    recordedAt: '2026-09-11T00:00:00.000Z',
    doseOccurrenceId: null,
    medicationName: null,
  };
}

describe('notes and measurements profile isolation', () => {
  it('does not render patient A clinical notes on the first patient B frame', async () => {
    const h = createHarness(screen, hook, {}, {
      '@/hooks/useTheme': { useTheme: () => theme },
      '@dawaee/shared': shared,
      'expo-router': { router: { back: () => undefined, push: () => undefined } },
    });

    try {
      const notes = h.requests.find((request: any) =>
        request.method === 'GET' && request.route === '/v1/notes' && request.payload?.profileId === 'A');
      const measurements = h.requests.find((request: any) =>
        request.method === 'GET' && request.route === '/v1/measurements' && request.payload?.profileId === 'A');
      expect(notes).toBeTruthy();
      expect(measurements).toBeTruthy();
      notes.resolve({ notes: [note('A')] });
      measurements.resolve({ measurements: [] });
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-NOTE');

      // Patient-scoped clinical state must disappear in the render caused by
      // the profile switch itself, before B's passive load has a chance to run.
      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-NOTE');
    } finally {
      h.unmount();
    }
  });
});
