import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
const notificationsSource = readFileSync(new URL('../src/notifications/index.ts', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../app/settings/notifications.tsx', import.meta.url), 'utf8');
const moduleSource = readFileSync(new URL('../modules/exact-alarm-access/index.ts', import.meta.url), 'utf8');
const moduleConfig = JSON.parse(
  readFileSync(new URL('../modules/exact-alarm-access/expo-module.config.json', import.meta.url), 'utf8'),
);
const moduleGradle = readFileSync(new URL('../modules/exact-alarm-access/android/build.gradle', import.meta.url), 'utf8');
const kotlinSource = readFileSync(
  new URL(
    '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/ExactAlarmAccessModule.kt',
    import.meta.url,
  ),
  'utf8',
);

describe('Android exact-alarm release policy', () => {
  it('uses the user-granted exact-alarm permission and blocks the restricted auto-granted one', () => {
    const permissions = config.android.permissions ?? [];
    const blocked = config.android.blockedPermissions ?? [];

    expect(permissions).toContain('SCHEDULE_EXACT_ALARM');
    expect(permissions).not.toContain('USE_EXACT_ALARM');
    expect(blocked).toContain('android.permission.USE_EXACT_ALARM');
  });

  it('reads the current Android exact-alarm special access instead of trusting process memory', () => {
    expect(moduleConfig.platforms).toEqual(['android']);
    expect(moduleConfig.android.modules).toContain('app.dawaee.exactalarm.ExactAlarmAccessModule');
    expect(moduleGradle).toContain("apply plugin: 'expo-module-gradle-plugin'");
    expect(kotlinSource).toContain('alarmManager.canScheduleExactAlarms()');
    expect(moduleSource).toContain("requireOptionalNativeModule('DawaeeExactAlarmAccess')");
    expect(notificationsSource).toContain('canScheduleExactAlarmsOnDevice()');
    expect(notificationsSource).not.toContain('exactAlarmsObservedUnavailable');
  });

  it('routes remediation to the app-scoped Alarms & reminders screen with ordinary settings fallback', () => {
    expect(kotlinSource).toContain('Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM');
    expect(kotlinSource).toContain('Uri.parse("package:${context.packageName}")');
    expect(kotlinSource).toContain('Settings.ACTION_APPLICATION_DETAILS_SETTINGS');
    expect(settingsSource).toContain('openExactAlarmSettings()');
    expect(settingsSource).toContain('void Linking.openSettings()');
  });

  it('reports a successful native fallback so JavaScript does not launch application settings twice', () => {
    expect(kotlinSource).toContain('return@Function openApplicationSettings(context, packageUri)');
    expect(kotlinSource).toContain('private fun openApplicationSettings(context: Context, packageUri: Uri): Boolean');
    expect(kotlinSource).toContain('return runCatching');
    expect(kotlinSource).toContain('context.startActivity(fallback)\n      true');
    expect(kotlinSource).toContain('.getOrDefault(false)');
  });
});
