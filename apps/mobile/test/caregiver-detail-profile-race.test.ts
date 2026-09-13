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

function sharedOverride() {
  return {
    CAREGIVER_NOTIFY_MODES: ['missed_only', 'consecutive_missed', 'daily_summary', 'weekly_summary'],
    CAREGIVER_PERMISSIONS: ['view_medications', 'view_schedule', 'view_adherence', 'confirm_dose'],
    toggleCaregiverPermission: (current: string[], permission: string) => current.includes(permission)
      ? current.filter((value) => value !== permission)
      : [...current, permission],
  };
}

function overrides() {
  return {
    'expo-router': {
      useLocalSearchParams: () => ({}),
      router: { back: () => undefined, push: () => undefined, replace: () => undefined },
    },
    '@/navigation/private-navigation': {
      getCaregiverDetailRouteIntent: (userId: string, patientProfileId: string) => ({
        userId, patientProfileId, relationshipId,
      }),
      setCaregiverDetailRouteIntent: () => undefined,
    },
    '@dawaee/shared': sharedOverride(),
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

function mutationHarness() {
  const gate = deferred();
  const replacements: string[] = [];
  let alertButtons: any[] = [];
  const customOverrides = {
    'react-native': {
      Alert: { alert: (_title: unknown, _body: unknown, buttons: any[]) => { alertButtons = buttons; } },
      Switch: 'Switch',
      View: 'View',
    },
    'expo-router': {
      useLocalSearchParams: () => ({ id: relationshipId }),
      router: {
        back: () => undefined,
        push: () => undefined,
        replace: (route: string) => { replacements.push(route); },
      },
    },
    '@/api/client': {
      NetworkError,
      ApiError,
      api: {
        get: async (_route: string, query?: { profileId?: string }) => ({
          viewerRole: 'owner',
          caregivers: [caregiver(query?.profileId ?? 'A')],
        }),
        post: async () => gate.promise,
        patch: async () => undefined,
        put: async () => undefined,
      },
    },
    '@dawaee/shared': sharedOverride(),
  };
  const h = createHarness(screen, hook, {}, customOverrides);
  return {
    h,
    gate,
    replacements,
    confirmRevoke: () => {
      const button = h.find('Button', (props: any) => props.label === 'family.revokeAccess');
      expect(button).not.toBeNull();
      button.onPress();
      const destructive = alertButtons.find((entry) => entry.style === 'destructive');
      expect(destructive).toBeTruthy();
      destructive.onPress();
    },
  };
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

  it('does not render patient A caregiver data on the first patient B frame', async () => {
    const h = createHarness(screen, hook, {}, overrides());
    try {
      const a = h.batch();
      expect(a).toHaveLength(1);
      answerCareCircle(a, 'A');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');

      h.switchProfile('B');
      const b = h.batch().filter((request: any) => !a.includes(request));
      expect(b).toHaveLength(1);

      // The selection has already changed. Old-patient data must disappear in
      // that render, before B's asynchronous response has any chance to arrive.
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-ONLY');
    } finally {
      h.unmount();
    }
  });

  it('late patient A revoke success cannot navigate patient B away', async () => {
    const { h, gate, replacements, confirmRevoke } = mutationHarness();
    try {
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');
      confirmRevoke();

      h.switchProfile('B');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');

      gate.resolve({});
      await h.flush();
      expect(h.app.activeProfile.id).toBe('B');
      expect(replacements).not.toContain('/(tabs)/family');
    } finally {
      h.unmount();
    }
  });

  it('late patient A revoke failure cannot mark patient B offline', async () => {
    const { h, gate, confirmRevoke } = mutationHarness();
    try {
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-ONLY');
      confirmRevoke();

      h.switchProfile('B');
      await h.flush();
      expect(h.app.offline).toBe(false);
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');

      gate.reject(new NetworkError('controlled stale revoke failure'));
      await h.flush();
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.app.offline).toBe(false);
    } finally {
      h.unmount();
    }
  });
});
