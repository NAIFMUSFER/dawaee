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

function resolveProfile(h: any, profileId: string, label: string) {
  const notes = h.requests.find((request: any) =>
    request.method === 'GET' && request.route === '/v1/notes' && request.payload?.profileId === profileId && !request.__resolved);
  const measurements = h.requests.find((request: any) =>
    request.method === 'GET' && request.route === '/v1/measurements' && request.payload?.profileId === profileId && !request.__resolved);
  expect(notes).toBeTruthy();
  expect(measurements).toBeTruthy();
  notes.__resolved = true;
  measurements.__resolved = true;
  notes.resolve({ notes: [note(label)] });
  measurements.resolve({ measurements: [] });
}

function harness() {
  return createHarness(screen, hook, {}, {
    '@/hooks/useTheme': { useTheme: () => theme },
    '@dawaee/shared': shared,
    'expo-router': { router: { back: () => undefined, push: () => undefined } },
  });
}

describe('notes and measurements profile isolation', () => {
  it('does not render patient A clinical notes on the first patient B frame', async () => {
    const h = harness();
    try {
      resolveProfile(h, 'A', 'A');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-NOTE');

      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-NOTE');
    } finally {
      h.unmount();
    }
  });

  it('does not let a late patient A response replace patient B notes', async () => {
    const h = harness();
    try {
      h.switchProfile('B');
      resolveProfile(h, 'B', 'B');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-B-NOTE');

      resolveProfile(h, 'A', 'A');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-B-NOTE');
      expect(h.text()).not.toContain('SYNTHETIC-A-NOTE');
    } finally {
      h.unmount();
    }
  });
});
