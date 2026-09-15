import { existsSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

function optionalSource(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

const receiverManifest = optionalSource(
  '../modules/exact-alarm-access/android/src/main/AndroidManifest.xml',
);
const receiverSource = optionalSource(
  '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/ExactAlarmPermissionReceiver.kt',
);
const recoveryJobSource = optionalSource(
  '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/ExactAlarmRecoveryJobService.kt',
);
const moduleGradle = optionalSource('../modules/exact-alarm-access/android/build.gradle');
const nativeWorkflow = optionalSource('../../../.github/workflows/android-native.yml');
const mobileLock = JSON.parse(optionalSource('../package-lock.json')) as {
  packages: Record<string, { version?: string }>;
};
const expoNotificationsVersion = mobileLock.packages['node_modules/expo-notifications']?.version;

function executableKotlinLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => (
      line.length > 0
      && !line.startsWith('//')
      && !line.startsWith('*')
      && !line.startsWith('/**')
      && !line.startsWith('*/')
    ));
}

describe('Android exact-alarm permission broadcast recovery', () => {
  it('registers a non-exported receiver for the system grant broadcast', () => {
    expect(receiverManifest).toContain('android:name=".ExactAlarmPermissionReceiver"');
    expect(receiverManifest).toContain('android:enabled="true"');
    expect(receiverManifest).toContain('android:exported="false"');
    expect(receiverManifest).toContain(
      'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
    );
  });

  it('rechecks special access and delegates persisted-alarm replay to the lifecycle-managed job', () => {
    expect(receiverSource).toContain(
      'intent?.action != AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
    );
    expect(receiverSource).toContain('alarmManager.canScheduleExactAlarms()');
    expect(receiverSource).toContain(
      'ExactAlarmRecoveryJobService.schedule(context.applicationContext)',
    );

    expect(recoveryJobSource).toContain('val delegate = ExpoSchedulingDelegate(context)');
    expect(recoveryJobSource).toContain('for (request in delegate.getAllScheduledNotifications())');
    expect(recoveryJobSource).toContain('delegate.scheduleNotification(request)');

    // Expo's bulk restore helper can log notification request identifiers. The
    // recovery job must instead replay requests individually behind our gate.
    expect(
      executableKotlinLines(recoveryJobSource)
        .some((line) => line.includes('.setupScheduledNotifications()')),
    ).toBe(false);

    expect(`${receiverSource}\n${recoveryJobSource}`).not.toMatch(/startActivity|React|AsyncStorage|SecureStore/);

    const nativeLogCalls = `${receiverSource}\n${recoveryJobSource}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('Log.'));
    expect(new Set(nativeLogCalls)).toEqual(new Set([
      'Log.e(TAG, "Exact-alarm grant recovery could not be scheduled")',
      'Log.e(TAG, "Exact-alarm grant recovery failed")',
    ]));
  });

  it('removes expired persisted triggers before Expo can log their notification identifiers', () => {
    expect(recoveryJobSource).toContain(
      'import expo.modules.notifications.notifications.interfaces.SchedulableNotificationTrigger',
    );
    expect(recoveryJobSource).toContain('val trigger = request.trigger');

    const staleGuard = recoveryJobSource.indexOf(
      'if (trigger is SchedulableNotificationTrigger && trigger.nextTriggerDate() == null)',
    );
    const privateRemoval = recoveryJobSource.indexOf(
      'delegate.removeScheduledNotifications(listOf(request.identifier))',
    );
    const replay = recoveryJobSource.indexOf('delegate.scheduleNotification(request)');

    expect(staleGuard).toBeGreaterThan(-1);
    expect(privateRemoval).toBeGreaterThan(staleGuard);
    expect(replay).toBeGreaterThan(privateRemoval);
  });

  it('compiles and inspects the receiver and recovery job in the release APK gate', () => {
    expect(expoNotificationsVersion).toBeTruthy();
    expect(moduleGradle).toContain(
      `implementation 'host.exp.exponent:expo.modules.notifications:${expoNotificationsVersion}'`,
    );
    expect(nativeWorkflow).toContain(
      'dex code --class app.dawaee.exactalarm.ExactAlarmPermissionReceiver',
    );
    expect(nativeWorkflow).toContain(
      'dex code --class app.dawaee.exactalarm.ExactAlarmRecoveryJobService',
    );
    expect(nativeWorkflow).toContain(
      'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
    );
  });
});
