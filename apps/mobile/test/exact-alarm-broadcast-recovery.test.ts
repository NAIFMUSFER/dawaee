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
const moduleGradle = optionalSource('../modules/exact-alarm-access/android/build.gradle');
const nativeWorkflow = optionalSource('../../../.github/workflows/android-native.yml');
const mobileLock = JSON.parse(optionalSource('../package-lock.json')) as {
  packages: Record<string, { version?: string }>;
};
const expoNotificationsVersion = mobileLock.packages['node_modules/expo-notifications']?.version;

describe('Android exact-alarm permission broadcast recovery', () => {
  it('registers a non-exported receiver for the system grant broadcast', () => {
    expect(receiverManifest).toContain('android:name=".ExactAlarmPermissionReceiver"');
    expect(receiverManifest).toContain('android:enabled="true"');
    expect(receiverManifest).toContain('android:exported="false"');
    expect(receiverManifest).toContain(
      'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
    );
  });

  it('rechecks special access and restores persisted Expo alarms without identifier-logging bulk restore', () => {
    expect(receiverSource).toContain(
      'intent?.action != AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
    );
    expect(receiverSource).toContain('alarmManager.canScheduleExactAlarms()');
    expect(receiverSource).toContain(
      'val delegate = ExpoSchedulingDelegate(context.applicationContext)',
    );
    expect(receiverSource).toContain('delegate.getAllScheduledNotifications().forEach { request ->');
    expect(receiverSource).toContain('delegate.scheduleNotification(request)');

    // The receiver intentionally documents why Expo's bulk restore helper is
    // unsafe here, so search executable Kotlin lines rather than comments.
    const executableReceiverLines = receiverSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => (
        line.length > 0
        && !line.startsWith('//')
        && !line.startsWith('*')
        && !line.startsWith('/**')
        && !line.startsWith('*/')
      ));
    expect(executableReceiverLines.some((line) => line.includes('.setupScheduledNotifications()'))).toBe(false);

    expect(receiverSource).toContain('val pendingResult = goAsync()');
    expect(receiverSource).toContain('pendingResult.finish()');
    expect(receiverSource).not.toMatch(/startActivity|React|AsyncStorage|SecureStore/);

    const nativeLogCalls = receiverSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('Log.'));
    expect(nativeLogCalls).toEqual(['Log.e(TAG, "Exact-alarm grant recovery failed")']);
  });

  it('removes expired persisted triggers before Expo can log their notification identifiers', () => {
    expect(receiverSource).toContain(
      'import expo.modules.notifications.notifications.interfaces.SchedulableNotificationTrigger',
    );
    expect(receiverSource).toContain('val trigger = request.trigger');

    const staleGuard = receiverSource.indexOf(
      'if (trigger is SchedulableNotificationTrigger && trigger.nextTriggerDate() == null)',
    );
    const privateRemoval = receiverSource.indexOf(
      'delegate.removeScheduledNotifications(listOf(request.identifier))',
    );
    const replay = receiverSource.indexOf('delegate.scheduleNotification(request)');

    expect(staleGuard).toBeGreaterThan(-1);
    expect(privateRemoval).toBeGreaterThan(staleGuard);
    expect(replay).toBeGreaterThan(privateRemoval);
  });

  it('compiles and inspects the receiver in the release APK gate', () => {
    expect(expoNotificationsVersion).toBeTruthy();
    expect(moduleGradle).toContain(
      `implementation 'host.exp.exponent:expo.modules.notifications:${expoNotificationsVersion}'`,
    );
    expect(nativeWorkflow).toContain(
      'dex code --class app.dawaee.exactalarm.ExactAlarmPermissionReceiver',
    );
    expect(nativeWorkflow).toContain(
      'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
    );
  });
});
