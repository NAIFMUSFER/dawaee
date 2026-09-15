import { existsSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

function optionalSource(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

const receiverSource = optionalSource(
  '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/ExactAlarmPermissionReceiver.kt',
);
const coordinatorSource = optionalSource(
  '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/NotificationScheduleMutationCoordinator.kt',
);
const nativeModuleSource = optionalSource(
  '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/ExactAlarmAccessModule.kt',
);
const nativeBindingSource = optionalSource('../modules/exact-alarm-access/index.ts');
const notificationsSource = optionalSource('../src/notifications/index.ts');

describe('Android exact-alarm recovery schedule serialization', () => {
  it('shares one native mutation gate between grant replay and JavaScript schedule changes', () => {
    expect(coordinatorSource).toContain('Semaphore(1, true)');
    expect(coordinatorSource).toContain('fun acquire()');
    expect(coordinatorSource).toContain('fun release()');
    expect(coordinatorSource).toContain('fun <T> withLease');

    const receiverLease = receiverSource.indexOf('NotificationScheduleMutationCoordinator.withLease');
    const receiverSnapshot = receiverSource.indexOf('delegate.getAllScheduledNotifications()');
    const receiverReplay = receiverSource.indexOf('delegate.scheduleNotification(request)');
    expect(receiverLease).toBeGreaterThan(-1);
    expect(receiverSnapshot).toBeGreaterThan(receiverLease);
    expect(receiverReplay).toBeGreaterThan(receiverSnapshot);

    expect(nativeModuleSource).toContain('AsyncFunction("acquireNotificationScheduleMutation")');
    expect(nativeModuleSource).toContain('Function("releaseNotificationScheduleMutation")');
    expect(nativeBindingSource).toContain('withExactAlarmScheduleMutation');
    expect(nativeBindingSource).toContain('acquireNotificationScheduleMutation');
    expect(nativeBindingSource).toContain('releaseNotificationScheduleMutation');

    const scheduleMutation = notificationsSource.indexOf('function withScheduleMutation');
    const serializedMutation = notificationsSource.indexOf('withExactAlarmScheduleMutation', scheduleMutation);
    expect(scheduleMutation).toBeGreaterThan(-1);
    expect(serializedMutation).toBeGreaterThan(scheduleMutation);
  });
});
