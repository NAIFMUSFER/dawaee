import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile?: string, profile?: object, overrides?: object) => any;
};

const screen = fileURLToPath(new URL('../app/medication/capture.tsx', import.meta.url));
const hook = fileURLToPath(new URL('../src/hooks/useRequestScope.ts', import.meta.url));

function makeHarness(mode = 'upload') {
  const uploadPuts: Array<{ url: string; init: Record<string, unknown> | undefined }> = [];
  const drafts: unknown[] = [];
  const prefills: unknown[] = [];
  const replacements: string[] = [];
  let cameraCalls = 0;

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
      useLocalSearchParams: () => ({ mode }),
    },
    'expo-image-picker': {
      requestCameraPermissionsAsync: async () => ({ granted: true }),
      launchCameraAsync: async () => ++cameraCalls === 1
        ? { canceled: false, assets: [{ uri: 'file://synthetic-medication-label', mimeType: 'image/jpeg' }] }
        : { canceled: true },
      requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
      launchImageLibraryAsync: async () => ({
        canceled: false,
        assets: [{ uri: 'file://synthetic-medication-label', mimeType: 'image/jpeg' }],
      }),
    },
    '@/storage/medication-draft': {
      clearMedicationDrafts: () => undefined,
      setMedicationConfirmDraft: (payload: unknown) => { drafts.push(payload); },
      setMedicationPrefillDraft: (payload: unknown) => { prefills.push(payload); },
    },
  });

  return { h, uploadPuts, drafts, prefills, replacements };
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

function resolveFinalize(request: any) {
  request.completed = true;
  request.resolve({ ok: true, objectKey: 'profiles/A/synthetic-label.jpg' });
}

describe('medication capture profile isolation', () => {
  it('a profile switch invalidates an in-flight A upload ticket before object upload, finalization or OCR', async () => {
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
      expect(pending(h, '/v1/uploads/finalize')).toHaveLength(0);
      expect(pending(h, '/v1/ocr/analyze')).toHaveLength(0);
      expect(drafts).toHaveLength(0);
      expect(replacements).toHaveLength(0);
    } finally {
      h.unmount();
    }
  });

  it('does not start OCR until the uploaded object has been finalized', async () => {
    const { h, uploadPuts } = makeHarness();
    try {
      chooseFile(h);
      await h.flush();

      const tickets = pending(h, '/v1/uploads/request');
      expect(tickets).toHaveLength(1);
      resolveTicket(tickets[0]);
      await h.flush();

      expect(uploadPuts).toHaveLength(1);
      const finalizations = pending(h, '/v1/uploads/finalize');
      expect(finalizations).toHaveLength(1);
      expect(finalizations[0].payload).toEqual({ objectKey: 'profiles/A/synthetic-label.jpg' });
      expect(pending(h, '/v1/ocr/analyze')).toHaveLength(0);

      resolveFinalize(finalizations[0]);
      await h.flush();
      expect(pending(h, '/v1/ocr/analyze')).toHaveLength(1);
    } finally {
      h.unmount();
    }
  });

  it('a profile switch while finalization is in flight prevents A OCR and draft writes', async () => {
    const { h, uploadPuts, drafts, replacements } = makeHarness();
    try {
      chooseFile(h);
      await h.flush();

      const tickets = pending(h, '/v1/uploads/request');
      resolveTicket(tickets[0]);
      await h.flush();
      expect(uploadPuts).toHaveLength(1);

      const finalizations = pending(h, '/v1/uploads/finalize');
      expect(finalizations).toHaveLength(1);
      h.switchProfile('B', false);
      resolveFinalize(finalizations[0]);
      await h.flush();

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
      const finalizations = pending(h, '/v1/uploads/finalize');
      expect(finalizations).toHaveLength(1);
      resolveFinalize(finalizations[0]);
      await h.flush();

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

it('carries complete OCR text in the profile draft while keeping navigation free of label data', async () => {
  const { h, drafts, replacements } = makeHarness();
  try {
    chooseFile(h);
    await h.flush();
    resolveTicket(pending(h, '/v1/uploads/request')[0]);
    await h.flush();
    resolveFinalize(pending(h, '/v1/uploads/finalize')[0]);
    await h.flush();
    const request = pending(h, '/v1/ocr/analyze')[0];
    const rawText = 'SYNTHETIC CONCENTRATION 250 mg/5 ml';
    request.completed = true;
    request.resolve({
      kind: 'medication_label',
      detected: { name: { value: 'Synthetic medicine', confidence: 0.6, confidenceSource: 'heuristic' } },
      rawText,
    });
    await h.flush();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ patientProfileId: 'A', rawText });
    expect(replacements).toEqual(['/medication/confirm']);
    expect(JSON.stringify(replacements)).not.toContain(rawText);
  } finally { h.unmount(); }
});


it('preserves a finalized photo through OCR failure and manual entry without leaking it into the route', async () => {
  const { h, prefills, replacements, uploadPuts } = makeHarness();
  try {
    chooseFile(h); await h.flush();
    resolveTicket(pending(h, '/v1/uploads/request')[0]); await h.flush();
    resolveFinalize(pending(h, '/v1/uploads/finalize')[0]); await h.flush();
    pending(h, '/v1/ocr/analyze')[0].reject(new Error('Synthetic provider unavailable')); await h.flush();
    h.find('Button', (p: any) => p.label === 'medication.manualEntry').onPress(); await h.flush();
    expect(prefills).toEqual([{ patientProfileId: 'A', imageKey: 'profiles/A/synthetic-label.jpg', identitySource: 'user' }]);
    expect(uploadPuts).toHaveLength(1);
    expect(replacements).toEqual([{ pathname: '/medication/quick-create', params: { source: 'capture' } }]);
    expect(JSON.stringify(replacements)).not.toContain('synthetic-label');
  } finally { h.unmount(); }
});


it('does not attach the discarded image after cancelling a retake and choosing manual entry', async () => {
  const { h, prefills, replacements } = makeHarness('photo');
  try {
    h.find('Button', (p: any) => p.label === 'capture.shutter').onPress(); await h.flush();
    h.find('Button', (p: any) => p.label === 'capture.use').onPress(); await h.flush();
    resolveTicket(pending(h, '/v1/uploads/request')[0]); await h.flush();
    resolveFinalize(pending(h, '/v1/uploads/finalize')[0]); await h.flush();
    pending(h, '/v1/ocr/analyze')[0].reject(new Error('Synthetic provider unavailable')); await h.flush();
    h.find('Button', (p: any) => p.label === 'capture.retake').onPress(); await h.flush();
    expect(h.find('Image')).toBeNull();
    h.find('Button', (p: any) => p.label === 'medication.manualEntry').onPress(); await h.flush();
    expect(prefills).toEqual([]);
    expect(replacements).toEqual(['/medication/quick-create']);
  } finally { h.unmount(); }
});
