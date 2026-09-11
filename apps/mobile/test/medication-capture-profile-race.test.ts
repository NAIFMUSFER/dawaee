import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile?: string, profile?: object, overrides?: object) => any;
};

const screen = fileURLToPath(new URL('../app/medication/capture.tsx', import.meta.url));
const hook = fileURLToPath(new URL('../src/hooks/useRequestScope.ts', import.meta.url));

function makeHarness() {
  const uploadPuts: Array<{ url: string; init: Record<string, unknown> | undefined }> = [];
  const drafts: unknown[] = [];
  const replacements: string[] = [];

  const fetch = async (input: string, init?: Record<string, unknown>) => {
    if (input === 'file://synthetic-medication-label') {
      return {
        ok: true,
        status: 200,
        blob: async () => ({ type: 'image/jpeg', size: 128 }),
      };
    }
    if (input.startsWith('https://storage.invalid/')) {
      uploadPuts.push({ url: input, init });
      return { ok: true, status: 200 };
    }
    throw new Error(`unexpected fetch: ${input}`);
  };

  const h = createHarness(screen, hook, {}, {
    __globals: { fetch },
    'expo-router': {
      router: {
        push: () => undefined,
        replace: (route: string) => { replacements.push(route); },
        back: () => undefined,
      },
      useLocalSearchParams: () => ({ mode: 'upload' }),
    },
    'expo-image-picker': {
      requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
      launchImageLibraryAsync: async () => ({
        canceled: false,
        assets: [{ uri: 'file://synthetic-medication-label', mimeType: 'image/jpeg' }],
      }),
    },
    '@/storage/medication-draft': {
      clearMedicationDrafts: () => undefined,
      setMedicationConfirmDraft: (payload: unknown) => { drafts.push(payload); },
    },
  });

  return { h, uploadPuts, drafts, replacements };
}

function chooseFile(h: any) {
  const button = h.find('Button', (props: Record<string, unknown>) => props.label === 'capture.chooseFile');
  expect(button).toBeTruthy();
  button.onPress();
}

function pending(h: any, route: string) {
  return h.batch().filter((request: any) => request.route === route);
}

function resolveTicket(request: any) {
  request.completed = true;
  request.resolve({
    objectKey: 'profiles/A/synthetic-label.jpg',
    upload: {
      uploadUrl: 'https://storage.invalid/A',
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  });
}

describe('medication capture profile isolation', () => {
  it('a profile switch invalidates an in-flight A upload ticket before object upload or OCR', async () => {
    const { h, uploadPuts, drafts, replacements } = makeHarness();
    try {
      chooseFile(h);
      await h.flush();

      const tickets = pending(h, '/v1/uploads/request');
      expect(tickets).toHaveLength(1);
      expect(tickets[0].payload.patientProfileId).toBe('A');
      expect(h.find('Loading')).toBeTruthy();

      // The first B render is a fresh capture scope rather than A's working UI.
      h.switchProfile('B', false);
      expect(h.find('Loading')).toBeNull();
      expect(h.find('Button', (props: Record<string, unknown>) => props.label === 'capture.chooseFile')).toBeTruthy();

      resolveTicket(tickets[0]);
      await h.flush();

      expect(uploadPuts).toHaveLength(0);
      expect(pending(h, '/v1/ocr/analyze')).toHaveLength(0);
      expect(drafts).toHaveLength(0);
      expect(replacements).toHaveLength(0);
    } finally {
      h.unmount();
    }
  });

  it('a late A OCR response cannot write a confirmation draft or navigate after switching to B', async () => {
    const { h, uploadPuts, drafts, replacements } = makeHarness();
    try {
      chooseFile(h);
      await h.flush();

      const tickets = pending(h, '/v1/uploads/request');
      expect(tickets).toHaveLength(1);
      resolveTicket(tickets[0]);
      await h.flush();

      expect(uploadPuts).toHaveLength(1);
      const ocr = pending(h, '/v1/ocr/analyze');
      expect(ocr).toHaveLength(1);
      expect(ocr[0].payload.patientProfileId).toBe('A');

      h.switchProfile('B', false);
      ocr[0].completed = true;
      ocr[0].resolve({
        kind: 'medication_label',
        language: 'en',
        detected: { name: { value: 'SYNTHETIC-A-ONLY', confidence: 0.99 } },
        rawText: 'SYNTHETIC-A-ONLY',
      });
      await h.flush();

      expect(drafts).toHaveLength(0);
      expect(replacements).toHaveLength(0);
      expect(h.find('Button', (props: Record<string, unknown>) => props.label === 'capture.chooseFile')).toBeTruthy();
    } finally {
      h.unmount();
    }
  });
});
