import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planExactAlarmGrantRecovery } from '../src/notifications/exact-alarm-recovery.js';

const settingsSource = readFileSync(new URL('../app/settings/notifications.tsx', import.meta.url), 'utf8');
const receiverSource = readFileSync(
  new URL(
    '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/ExactAlarmPermissionReceiver.kt',
    import.meta.url,
  ),
  'utf8',
);

const denied = { supported: true, permissionGranted: true, canScheduleExact: false } as const;
const granted = { supported: true, permissionGranted: true, canScheduleExact: true } as const;
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

describe('Android exact-alarm grant recovery ownership', () => {
  it('keeps the native grant receiver as the sole schedule-repair path', () => {
    expect(receiverSource).toContain(
      'AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
    );
    expect(receiverSource).toContain('alarmManager.canScheduleExactAlarms()');
    expect(receiverSource).toContain('delegate.getAllScheduledNotifications().forEach { request ->');
    expect(receiverSource).toContain('delegate.scheduleNotification(request)');

    // A denied -> granted transition is already repaired by the native
    // BroadcastReceiver. Returning a JS rebuild plan here would create a second
    // competing schedule mutation that can replay stale/duplicate payloads.
    expect(plan()).toBeNull();
  });

  it('never creates a JavaScript recovery plan for any account or platform state', () => {
    expect(plan({ profiles: [followed] })).toBeNull();
    expect(plan({ signedIn: false })).toBeNull();
    expect(plan({ platform: 'ios' })).toBeNull();
    expect(plan({ platform: 'web' })).toBeNull();
    expect(plan({ previous: granted })).toBeNull();
    expect(plan({ current: denied })).toBeNull();
  });

  it('still rechecks platform capability when Android returns to the foreground', () => {
    expect(settingsSource).toContain("AppState.addEventListener('change'");
    expect(settingsSource).toContain("nextState !== 'active'");
    expect(settingsSource).toContain('inspectCapability()');
    expect(settingsSource).toContain('capabilityRef.current = current');
    expect(settingsSource).toContain('setCapability(current)');

    // The current settings integration must honor the null plan before its
    // legacy rebuild call. This keeps the race closed until that dead path is
    // removed in a cleanup-only change.
    expect(settingsSource).toContain('if (!plan) return;');
    expect(settingsSource.indexOf('if (!plan) return;')).toBeLessThan(
      settingsSource.indexOf('await rebuildRemindersFromCache('),
    );
  });
});
