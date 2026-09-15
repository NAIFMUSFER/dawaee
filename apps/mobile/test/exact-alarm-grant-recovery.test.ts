import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(new URL('../app/settings/notifications.tsx', import.meta.url), 'utf8');
const receiverSource = readFileSync(
  new URL(
    '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/ExactAlarmPermissionReceiver.kt',
    import.meta.url,
  ),
  'utf8',
);

describe('Android exact-alarm grant recovery ownership', () => {
  it('uses the native grant receiver as the sole schedule-repair path', () => {
    expect(receiverSource).toContain(
      'AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
    );
    expect(receiverSource).toContain('alarmManager.canScheduleExactAlarms()');
    expect(receiverSource).toContain('delegate.getAllScheduledNotifications().forEach { request ->');
    expect(receiverSource).toContain('delegate.scheduleNotification(request)');

    // AppState may refresh what the settings UI reports, but must not mutate
    // the notification schedule after the same Android grant broadcast. The
    // receiver can already be replaying its snapshot concurrently; a JS
    // cancel/rebuild here can interleave and resurrect stale/duplicate payloads.
    expect(settingsSource).not.toContain('planExactAlarmGrantRecovery');
    expect(settingsSource).not.toContain('rebuildRemindersFromCache');
  });

  it('still rechecks platform capability when Android returns to the foreground', () => {
    expect(settingsSource).toContain("AppState.addEventListener('change'");
    expect(settingsSource).toContain("nextState !== 'active'");
    expect(settingsSource).toContain('inspectCapability()');
    expect(settingsSource).toContain('capabilityRef.current = current');
    expect(settingsSource).toContain('setCapability(current)');
  });

  it('does not add a second owner/profile-specific recovery scheduler in JavaScript', () => {
    expect(settingsSource).not.toContain('exactAlarmRecoveryScopeRef');
    expect(settingsSource).not.toContain('exactAlarmRecoveryContextRef');
    expect(settingsSource).not.toContain('selfOwnerProfileId');
  });
});
