import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/caregiver/[id].tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');
const relationshipId = 'relationship-under-test';

function overrides() {
  return {
    'expo-router': {
      useLocalSearchParams: () => ({ id: relationshipId }),
      router: { back: () => undefined, push: () => undefined, replace: () => undefined },
    },
    '@dawaee/shared': {
      CAREGIVER_NOTIFY_MODES: ['missed_only', 'consecutive_missed', 'daily_summary', 'weekly_summary'],
      CAREGIVER_PERMISSIONS: ['view_medications', 'view_schedule', 'view_adherence', 'confirm_dose'],
      toggleCaregiverPermission: (current: string[], permission: string) => current.includes(permission)
        ? current.filter((value) => value !== permission)
        : [...current, permission],
    },
  };
}

function answerCareCircle(batch: any[], label: string) {
  for (const request of batch) {
    request.completed = true;
    request.resolve({
      viewerRole: 'owner',
      caregivers: [{
        id: relationshipId,
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
        notificationRules: [],
      }],
    });
  }
}

describe('caregiver detail profile/request isolation', () => {
  it('late A success cannot overwrite already-rendered B caregiver data', async () => {
    const h = createHarness(screen, hook, {}, overrides());
    try {
      const a = h.batch();
      expect(a).toHaveLength(1);
      h.switchProfile('B');
      const b = h.batch().filter((request: any) => !a.includes(request));
      expect(b).toHaveLength(1);

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

  it('late A network failure cannot mark successful profile B offline', async () => {
    const h = createHarness(screen, hook, {}, overrides());
    try {
      const a = h.batch();
      expect(a).toHaveLength(1);
      h.switchProfile('B');
      const b = h.batch().filter((request: any) => !a.includes(request));
      expect(b).toHaveLength(1);

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
});
