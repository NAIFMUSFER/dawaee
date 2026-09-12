import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/settings/privacy.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');
const exportFileMock = { shareTemporaryExportFile: async () => false };

function reactNativeWithShare(sharedMessages: string[]) {
  const known = {
    Share: {
      dismissedAction: 'dismissedAction',
      share: async ({ message }: { message: string }) => {
        sharedMessages.push(message);
        return { action: 'sharedAction' };
      },
    },
  } as Record<string | symbol, unknown>;

  return new Proxy(known, {
    get(target, key) {
      if (key === '__esModule') return true;
      if (key in target) return target[key];
      return String(key);
    },
  });
}

describe('privacy data export profile isolation', () => {
  it('does not share patient A export after the user switches to patient B', async () => {
    const sharedMessages: string[] = [];
    const h = createHarness(screen, hook, {}, {
      'react-native': reactNativeWithShare(sharedMessages),
      '@/privacy/export-file': exportFileMock,
    });

    try {
      const exportButton = h.find('Button', (props: any) => props.label === 'settings.exportData');
      expect(exportButton).toBeTruthy();
      exportButton.onPress();
      await h.flush();

      const exportRequest = h.requests.find((request: any) => (
        request.method === 'GET'
        && request.route === '/v1/reports/export'
        && request.payload?.profileId === 'A'
      ));
      expect(exportRequest).toBeTruthy();

      h.switchProfile('B');
      await h.flush();
      expect(h.app.activeProfile.id).toBe('B');

      exportRequest.resolve({
        exportedAt: '2026-09-11T04:00:00Z',
        profileId: 'A',
        data: { medications: [{ name: 'SYNTHETIC-A-PRIVATE-EXPORT' }] },
      });
      await h.flush();

      expect(sharedMessages.join('\n')).not.toContain('SYNTHETIC-A-PRIVATE-EXPORT');
    } finally {
      h.unmount();
    }
  });
});
