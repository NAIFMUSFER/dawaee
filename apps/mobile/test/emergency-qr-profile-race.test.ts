import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/settings/emergency-qr.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

const disabledCard = {
  card: {
    includeMedications: false,
    includeAllergies: true,
    includeContacts: true,
    qrEnabled: false,
    qrViewCount: 0,
    qrLastViewedAt: null,
  },
};

const theme = {
  colors: new Proxy({}, { get: () => '#000' }),
  spacing: new Proxy({}, { get: () => 4 }),
  font: new Proxy({}, { get: () => 16 }),
  elderlyMode: false,
  lineHeight: (value: number) => value * 1.4,
};

describe('emergency QR profile isolation', () => {
  it('does not expose patient A one-time emergency QR capability on the first patient B frame', async () => {
    const h = createHarness(screen, hook, {}, {
      '@/hooks/useTheme': { useTheme: () => theme },
      '@/components/QrCode': { QrCode: 'QrCode', encodeQr: () => ({ ok: true }) },
      'expo-router': { router: { back: () => undefined, push: () => undefined } },
    });

    try {
      const initial = h.requests.find((request: any) => request.method === 'GET' && request.route === '/v1/emergency/card');
      expect(initial).toBeTruthy();
      initial.resolve(disabledCard);
      await h.flush();

      const enable = h.find('Button', (props: any) => props.label === 'emergency.qrEnable');
      expect(enable).toBeTruthy();
      enable.onPress();

      const post = h.requests.find((request: any) => request.method === 'POST' && request.route === '/v1/emergency/qr/enable');
      expect(post).toBeTruthy();
      post.resolve({ enabled: true, qrUrl: 'https://example.invalid/e/SYNTHETIC-A-SECRET' });
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-SECRET');

      // The one-time bearer capability is patient scoped. Changing profile must
      // destroy it in the very first B render, before any passive B load runs.
      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-SECRET');
    } finally {
      h.unmount();
    }
  });
});
