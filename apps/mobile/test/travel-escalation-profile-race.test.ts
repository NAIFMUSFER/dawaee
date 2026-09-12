import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');
const travelScreen = path.resolve(process.cwd(), 'apps/mobile/app/settings/travel.tsx');
const escalationScreen = path.resolve(process.cwd(), 'apps/mobile/app/caregiver/escalation.tsx');

function resolveTravel(requests: any[], label: string) {
  for (const request of requests) {
    if (request.method === 'POST' && request.route.endsWith('/timezone-check')) {
      request.resolve({ changed: true, from: 'Asia/Riyadh', to: 'Europe/London', offsetShiftHours: -3 });
    } else if (request.method === 'GET' && request.route === '/v1/today') {
      const dose = {
        id: `dose-${label}`,
        scheduledAt: '2026-09-11T09:00:00Z',
        scheduledLocalTime: '12:00',
        medication: { name: `SYNTHETIC-${label}-TRAVEL-MED` },
      };
      request.resolve({ today: [dose], next: dose });
    } else {
      throw new Error(`unexpected travel request ${request.method} ${request.route}`);
    }
  }
}

function resolveEscalation(requests: any[], label: string) {
  for (const request of requests) {
    if (request.method !== 'GET') throw new Error(`unexpected escalation method ${request.method}`);
    if (request.route === '/v1/escalation-policy') {
      request.resolve({
        policy: {
          id: null,
          medicationId: null,
          enabled: true,
          stages: [
            { afterMinutes: 0, target: 'patient', channels: ['push', 'local'] },
            { afterMinutes: 15, target: 'primary_caregiver', channels: ['push'] },
          ],
          quietHoursStart: label === 'A' ? '01:23' : '04:56',
          quietHoursEnd: '06:00',
        },
        isDefault: false,
        defaultStages: [],
      });
    } else if (request.route === '/v1/care-circle') {
      request.resolve({
        caregivers: [{
          id: `caregiver-${label}`,
          name: `SYNTHETIC-${label}-CAREGIVER`,
          status: 'active',
          permissions: ['receive_notifications'],
          escalationPriority: 1,
        }],
        viewerRole: 'owner',
      });
    } else if (request.route === '/v1/today') {
      request.resolve({
        today: [{ scheduledAt: '2026-09-11T17:00:00Z' }],
        next: { scheduledAt: '2026-09-11T17:00:00Z' },
      });
    } else {
      throw new Error(`unexpected escalation request ${request.route}`);
    }
  }
}

describe('travel mode profile isolation', () => {
  it('does not render patient A medication preview on the first patient B frame', async () => {
    const h = createHarness(travelScreen, hook);
    try {
      const patientA = h.batch();
      expect(patientA).toHaveLength(2);
      resolveTravel(patientA, 'A');
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-TRAVEL-MED');

      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-TRAVEL-MED');
    } finally {
      h.unmount();
    }
  });

  it('drops patient A travel responses that resolve after switching to patient B', async () => {
    const h = createHarness(travelScreen, hook);
    try {
      const patientA = h.batch();
      expect(patientA).toHaveLength(2);

      h.switchProfile('B', false);
      resolveTravel(patientA, 'A');
      await h.flush();

      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-TRAVEL-MED');
    } finally {
      h.unmount();
    }
  });
});

describe('caregiver escalation profile isolation', () => {
  it('does not render patient A escalation settings on the first patient B frame', async () => {
    const h = createHarness(escalationScreen, hook);
    try {
      const patientA = h.batch();
      expect(patientA).toHaveLength(3);
      resolveEscalation(patientA, 'A');
      await h.flush();
      expect(h.text()).toContain('01:23');

      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('01:23');
    } finally {
      h.unmount();
    }
  });

  it('drops patient A escalation responses that resolve after switching to patient B', async () => {
    const h = createHarness(escalationScreen, hook);
    try {
      const patientA = h.batch();
      expect(patientA).toHaveLength(3);

      h.switchProfile('B', false);
      resolveEscalation(patientA, 'A');
      await h.flush();

      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('01:23');
    } finally {
      h.unmount();
    }
  });
});
