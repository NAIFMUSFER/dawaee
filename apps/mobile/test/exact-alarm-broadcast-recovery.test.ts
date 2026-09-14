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

  it('rechecks special access and restores persisted Expo notification alarms off the JS lifecycle', () => {
    expect(receiverSource).toContain(
      'intent?.action != AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
    );
    expect(receiverSource).toContain('alarmManager.canScheduleExactAlarms()');
    expect(receiverSource).toContain(
      'ExpoSchedulingDelegate(context.applicationContext).setupScheduledNotifications()',
    );
    expect(receiverSource).toContain('val pendingResult = goAsync()');
    expect(receiverSource).toContain('pendingResult.finish()');
    expect(receiverSource).not.toMatch(/startActivity|React|AsyncStorage|SecureStore/);
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
