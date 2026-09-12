import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
  deferred: () => { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error: unknown) => void };
  NetworkError: new (message?: string) => Error;
  ApiError: new (code: string) => Error;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/caregiver/[id].tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');
const relationshipId = 'relationship-under-test';

function caregiver(label: string) {
  return {
    id: relationshipId,
    profileId: label,
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
  };
}

function sharedOverride() {
  return {
    CAREGIVER_NOTIFY_MODES: ['missed_only', 'consecutive_missed', 'daily_summary', 'weekly_summary'],
    CAREGIVER_PERMISSIONS: ['view_medications', 'view_schedule', 'view_adherence', 'confirm_dose'],
    toggleCaregiverPermission: (current: string[], permission: string) => current.includes(permission)
      ? current.filter((value) => value !== permission)
      : [...current, permission],
  };
}

function harness() {
  const permissionGate = deferred();
  const ruleGate = deferred();
  const h = createHarness(screen, hook, {}, {
    'expo-router': {
      useLocalSearchParams: () => ({ id: relationshipId }),
      router: { back: () => undefined, push: () => undefined, replace: () => undefined },
    },
    '@/api/client': {
      NetworkError,
      ApiError,
      api: {
        get: async (_route: string, query?: { profileId?: string }) => ({
          viewerRole: 'owner',
          caregivers: [caregiver(query?.profileId ?? 'A')],
        }),
        patch: async () => permissionGate.promise,
        put: async () => ruleGate.promise,
        post: async () => undefined,
      },
    },
    '@dawaee/shared': sharedOverride(),
  });
  return { h, permissionGate, ruleGate };
}

describe('caregiver save mutation profile isolation', () => {
  it('late patient A permission-save network failure cannot mark patient B offline', async () => {
    const { h, permissionGate } = harness();
    try {
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');

      const later = h.find('Button', (props: any) => props.label === '+');
      expect(later).not.toBeNull();
      later.onPress();
      await h.flush();

      const save = h.find('Button', (props: any) => props.testID === 'save-permissions');
      expect(save).not.toBeNull();
      expect(save.disabled).toBe(false);
      save.onPress();

      h.switchProfile('B');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');
      expect(h.app.offline).toBe(false);

      permissionGate.reject(new NetworkError('controlled stale permission-save failure'));
      await h.flush();
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.app.offline).toBe(false);
    } finally {
      h.unmount();
    }
  });

  it('late patient A notification-rule network failure cannot mark patient B offline', async () => {
    const { h, ruleGate } = harness();
    try {
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');

      // The deterministic harness intentionally evaluates the route and keyed
      // screen boundary only; presentation children are left opaque. Invoke the
      // rule card callback exposed by that boundary instead of pretending its
      // nested Button was rendered by React Native.
      const ruleCard = h.find('ChannelRuleCard', (props: any) => props.channel === 'push');
      expect(ruleCard).not.toBeNull();
      ruleCard.onSave();

      h.switchProfile('B');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');
      expect(h.app.offline).toBe(false);

      ruleGate.reject(new NetworkError('controlled stale rule-save failure'));
      await h.flush();
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.app.offline).toBe(false);
    } finally {
      h.unmount();
    }
  });
});
