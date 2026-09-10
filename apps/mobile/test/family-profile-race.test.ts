import { describe, expect, it } from 'vitest';
import path from 'node:path';

// The harness executes the checked-in TSX screen with controlled request promises.
const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
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

function createAlertOverride() {
  const alerts: any[][] = [];
  const reactNative = new Proxy({
    Alert: { alert: (...args: any[]) => { alerts.push(args); } },
  } as Record<string, unknown>, {
    get(target, key) {
      if (key === '__esModule') return true;
      if (key in target) return target[key as string];
      return String(key);
    },
  });
  return { alerts, overrides: { 'react-native': reactNative } };
}

function startOwnerRevoke(h: any, alerts: any[][]) {
  const owner = h.find('OwnerView');
  expect(owner).toBeTruthy();
  expect(owner.active).toHaveLength(1);
  owner.onRevoke(owner.active[0]);
  expect(alerts).toHaveLength(1);
  const buttons = alerts[0]![2] as any[];
  const destructive = buttons.find((button: any) => button.style === 'destructive');
  expect(destructive).toBeTruthy();
  destructive.onPress();
  const revoke = h.batch().filter((request: any) => request.route === '/v1/caregivers/revoke');
  expect(revoke).toHaveLength(1);
  return revoke;
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

  it('late revoke failure from A cannot mark profile B offline', async () => {
    const { alerts, overrides } = createAlertOverride();
    const h = createHarness(screen, hook, {}, overrides);
    try {
      answerCareCircle(h.batch(), 'A');
      await h.flush();
      const revoke = startOwnerRevoke(h, alerts);

      h.switchProfile('B');
      const bLoads = h.batch().filter((request: any) => request.route === '/v1/care-circle');
      answerCareCircle(bLoads, 'B');
      await h.flush();
      expect(h.app.offline).toBe(false);

      h.fail(revoke);
      await h.flush();
      expect(h.app.offline).toBe(false);
      expect(h.text()).toContain('SYNTHETIC-B-ONLY');
    } finally {
      h.unmount();
    }
  });

  it('late revoke success from A cannot clear profile B offline state', async () => {
    const { alerts, overrides } = createAlertOverride();
    const h = createHarness(screen, hook, {}, overrides);
    try {
      answerCareCircle(h.batch(), 'A');
      await h.flush();
      const revoke = startOwnerRevoke(h, alerts);

      h.switchProfile('B');
      h.app.setOffline(true);
      h.render();
      expect(h.app.offline).toBe(true);

      for (const request of revoke) {
        request.completed = true;
        request.resolve({});
      }
      await h.flush();
      expect(h.app.offline).toBe(true);
    } finally {
      h.unmount();
    }
  });
});
