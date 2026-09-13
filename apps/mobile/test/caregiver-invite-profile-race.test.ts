import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/caregiver/invite.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

const caregiverPermissions = ['view_medications', 'view_schedule', 'receive_notifications'] as const;
const shared = {
  CAREGIVER_PERMISSIONS: caregiverPermissions,
  CAREGIVER_ROLES: ['son'],
  CAREGIVER_ROLE_PRESETS: {
    observer: ['view_medications'],
    family: ['view_medications', 'view_schedule'],
    nurse: ['view_medications'],
    emergency_only: ['receive_notifications'],
  },
  toggleCaregiverPermission: (current: string[], permission: string) => (
    current.includes(permission) ? current.filter((value) => value !== permission) : [...current, permission]
  ),
};

function harness() {
  return createHarness(screen, hook, {}, {
    '@dawaee/shared': shared,
    'expo-router': { router: { back: () => undefined, replace: () => undefined, push: () => undefined } },
  });
}

async function beginInvite(h: any) {
  const name = h.find('Field', (props: any) => props.label === 'invite.name');
  const phone = h.find('Field', (props: any) => props.label === 'invite.phone');
  expect(name).toBeTruthy();
  expect(phone).toBeTruthy();
  name.onChangeText('Synthetic caregiver A');
  phone.onChangeText('+966500000001');
  await h.flush();

  const send = h.find('Button', (props: any) => props.testID === 'invite-send');
  expect(send).toBeTruthy();
  send.onPress();

  const request = h.requests.find((entry: any) => entry.method === 'POST' && entry.route === '/v1/caregivers/invite');
  expect(request).toBeTruthy();
  expect(request.payload.patientProfileId).toBe('A');
  return request;
}

const result = {
  relationshipId: 'synthetic-rel-a',
  expiresAt: '2026-09-14T00:00:00.000Z',
  invitationLink: 'https://example.invalid/invite#/invite/SYNTHETIC-A-INVITE-SECRET',
  invitationMessage: 'synthetic invitation',
};

describe('caregiver invite capability profile isolation', () => {
  it('does not keep patient A invitation capability visible on the first patient B frame', async () => {
    const h = harness();
    try {
      const request = await beginInvite(h);
      request.resolve(result);
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-INVITE-SECRET');

      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-INVITE-SECRET');
    } finally {
      h.unmount();
    }
  });

  it('does not render patient A invitation capability when the response arrives after switching to B', async () => {
    const h = harness();
    try {
      const request = await beginInvite(h);
      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');

      request.resolve(result);
      await h.flush();
      expect(h.text()).not.toContain('SYNTHETIC-A-INVITE-SECRET');
    } finally {
      h.unmount();
    }
  });
});
