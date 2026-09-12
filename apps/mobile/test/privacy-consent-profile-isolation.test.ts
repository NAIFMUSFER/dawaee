import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/settings/privacy.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

type Pending = {
  route: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type Write = { route: string; body: Record<string, unknown> };

function controlledClient() {
  const pending: Pending[] = [];
  const writes: Write[] = [];

  class NetworkError extends Error {}
  class ApiError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }

  const api = {
    get: (route: string) => new Promise((resolve, reject) => {
      pending.push({ route, resolve, reject });
    }),
    put: async (route: string, body: Record<string, unknown>) => {
      writes.push({ route, body });
      return { consent: body };
    },
    post: async () => ({}),
  };

  return {
    pending,
    writes,
    module: { api, ApiError, NetworkError },
  };
}

function consentRows() {
  return [
    { type: 'ocr_image_processing', granted: true, patientProfileId: null },
    { type: 'ocr_image_processing', granted: false, patientProfileId: 'A' },
    // Deliberately last: a sibling decision must never overwrite A merely
    // because PostgreSQL returned this row later in an unordered result set.
    { type: 'ocr_image_processing', granted: true, patientProfileId: 'B' },
  ];
}

describe('privacy consent profile isolation', () => {
  it('uses the active profile decision rather than a sibling row returned later', async () => {
    const client = controlledClient();
    const h = createHarness(screen, hook, {}, { '@/api/client': client.module });

    try {
      expect(client.pending).toHaveLength(1);
      expect(client.pending[0]?.route).toBe('/v1/me');
      client.pending[0]!.resolve({ consents: consentRows() });
      await h.flush();

      const ocr = h.find('Switch', (props: any) => props.accessibilityLabel === 'privacy.ocr');
      expect(ocr).toBeTruthy();
      expect(ocr.value).toBe(false);
    } finally {
      h.unmount();
    }
  });

  it('writes the consent decision for the active patient profile', async () => {
    const client = controlledClient();
    const h = createHarness(screen, hook, {}, { '@/api/client': client.module });

    try {
      client.pending[0]!.resolve({
        consents: [{ type: 'ocr_image_processing', granted: true, patientProfileId: 'A' }],
      });
      await h.flush();

      const ocr = h.find('Switch', (props: any) => props.accessibilityLabel === 'privacy.ocr');
      expect(ocr).toBeTruthy();
      ocr.onValueChange(false);
      await h.flush();

      expect(client.writes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          route: '/v1/me/consents',
          body: expect.objectContaining({
            type: 'ocr_image_processing',
            granted: false,
            patientProfileId: 'A',
          }),
        }),
      ]));
    } finally {
      h.unmount();
    }
  });

  it('reloads on profile switch and ignores a late response from the previous profile', async () => {
    const client = controlledClient();
    const h = createHarness(screen, hook, {}, { '@/api/client': client.module });

    try {
      expect(client.pending).toHaveLength(1);
      h.switchProfile('B');
      await h.flush();

      // A profile-scoped privacy screen must issue a fresh read for B. Keep the
      // A request unresolved so this same regression also proves stale-response
      // fencing after the reload behavior is added.
      expect(client.pending).toHaveLength(2);

      client.pending[1]!.resolve({
        consents: [
          { type: 'ocr_image_processing', granted: true, patientProfileId: null },
          { type: 'ocr_image_processing', granted: true, patientProfileId: 'B' },
        ],
      });
      await h.flush();
      let ocr = h.find('Switch', (props: any) => props.accessibilityLabel === 'privacy.ocr');
      expect(ocr.value).toBe(true);

      client.pending[0]!.resolve({
        consents: [
          { type: 'ocr_image_processing', granted: true, patientProfileId: null },
          { type: 'ocr_image_processing', granted: false, patientProfileId: 'A' },
        ],
      });
      await h.flush();

      ocr = h.find('Switch', (props: any) => props.accessibilityLabel === 'privacy.ocr');
      expect(ocr.value).toBe(true);
    } finally {
      h.unmount();
    }
  });
});
