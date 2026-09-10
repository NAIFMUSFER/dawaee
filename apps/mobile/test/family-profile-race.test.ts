import { describe, expect, it } from 'vitest';
import path from 'node:path';

// The harness executes the checked-in TSX screen with controlled request promises.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/(tabs)/family.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

function answerCareCircle(batch: any[], label: string) {
  for (const request of batch) {
    request.completed = true;
    request.resolve({
      viewerRole: 'owner',
      presets: {},
      caregivers: [{
        id: `relationship-${label}`,
        profileId: request.payload?.profileId ?? label,
        caregiverUserId: `caregiver-${label}`,
        name: `SYNTHETIC-${label}-ONLY`,
        phone: `+9665000000${label === 'A' ? '1' : '2'}`,
        role: 'other',
        status: 'active',
        permissions: ['view_medications'],
        escalationPriority: 1,
        invitationExpiresAt: null,
        isYou: false,
      }],
    });
  }
}

describe('family screen profile/request isolation', () => {
  it('late A success cannot replace already-rendered B caregiver data', async () => {
    const h = createHarness(screen, hook);
    try {
      const a = h.batch();
      h.switchProfile('B');
      const b = h.batch().filter((request: any) => !a.includes(request));

      answerCareCircle(b, 'B');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');

      answerCareCircle(a, 'A');
      await h.flush();
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');
    } finally {
      h.unmount();
    }
  });

  it('first B render contains no already-rendered A caregiver data before passive effects', async () => {
    const h = createHarness(screen, hook);
    try {
      answerCareCircle(h.batch(), 'A');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');

      h.switchProfile('B', false);
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });

  it('late A network failure cannot mark successful B offline', async () => {
    const h = createHarness(screen, hook);
    try {
      const a = h.batch();
      h.switchProfile('B');
      const b = h.batch().filter((request: any) => !a.includes(request));
      answerCareCircle(b, 'B');
      await h.flush();
      expect(h.app.offline).toBe(false);

      h.fail(a);
      await h.flush();
      expect(h.app.offline).toBe(false);
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');
    } finally {
      h.unmount();
    }
  });

  it('newest same-profile refresh wins when responses complete out of order', async () => {
    const h = createHarness(screen, hook);
    try {
      answerCareCircle(h.batch(), 'INITIAL');
      await h.flush();

      h.find('RefreshControl').onRefresh();
      const older = h.batch();
      h.find('RefreshControl').onRefresh();
      const newer = h.batch().filter((request: any) => !older.includes(request));
      expect(older.length).toBeGreaterThan(0);
      expect(newer.length).toBeGreaterThan(0);

      answerCareCircle(newer, 'NEWER');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-NEWER-ONLY');

      answerCareCircle(older, 'OLDER');
      await h.flush();
      expect(h.text()).not.toContain('SYNTHETIC-OLDER-ONLY');
      expect(h.text()).toContain('SYNTHETIC-NEWER-ONLY');
    } finally {
      h.unmount();
    }
  });
});
