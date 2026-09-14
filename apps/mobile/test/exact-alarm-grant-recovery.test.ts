import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planExactAlarmGrantRecovery } from '../src/notifications/exact-alarm-recovery.js';

const settingsSource = readFileSync(new URL('../app/settings/notifications.tsx', import.meta.url), 'utf8');

const denied = { supported: true, permissionGranted: true, canScheduleExact: false } as const;
const granted = { supported: true, permissionGranted: true, canScheduleExact: true } as const;
const notificationsDenied = { supported: true, permissionGranted: false, canScheduleExact: false } as const;

const followed = { id: 'followed-profile', isSelf: false, role: 'caregiver' } as const;
const selfOwner = { id: 'self-owner-profile', isSelf: true, role: 'owner' } as const;

function plan(overrides: Record<string, unknown> = {}) {
  return planExactAlarmGrantRecovery({
    platform: 'android',
    previous: denied,
    current: granted,
    signedIn: true,
    profiles: [followed, selfOwner],
    locale: 'ar',
    voiceEnabled: true,
    showMedication: false,
    ...overrides,
  });
}

describe('Android exact-alarm grant recovery', () => {
  it('rebuilds only after an observed denied -> granted transition', () => {
    expect(plan()).toEqual({
      profileId: 'self-owner-profile',
      locale: 'ar',
      options: { voiceEnabled: true, showMedication: false },
    });

    expect(plan({ previous: granted })).toBeNull();
    expect(plan({ previous: null })).toBeNull();
    expect(plan({ current: denied })).toBeNull();
    expect(plan({ current: notificationsDenied })).toBeNull();
  });

  it('never rebuilds a followed patient or a signed-out account', () => {
    expect(plan({ profiles: [followed] })).toBeNull();
    expect(plan({ signedIn: false })).toBeNull();
    expect(plan({ platform: 'ios' })).toBeNull();
    expect(plan({ platform: 'web' })).toBeNull();
  });

  it('preserves the current reminder privacy and voice choices', () => {
    expect(plan({ locale: 'en', voiceEnabled: false, showMedication: true })).toEqual({
      profileId: 'self-owner-profile',
      locale: 'en',
      options: { voiceEnabled: false, showMedication: true },
    });
  });

  it('wires Android foreground return to capability recheck and cached-reminder repair', () => {
    expect(settingsSource).toContain("AppState.addEventListener('change'");
    expect(settingsSource).toContain("nextState !== 'active'");
    expect(settingsSource).toContain('planExactAlarmGrantRecovery');
    expect(settingsSource).toContain('rebuildRemindersFromCache');
    expect(settingsSource).toContain('exactAlarmRecoveryScopeRef');
  });
});
