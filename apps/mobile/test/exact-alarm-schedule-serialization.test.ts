import { existsSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

function optionalSource(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

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

const receiverSource = optionalSource(
  '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/ExactAlarmPermissionReceiver.kt',
);
const recoveryJobSource = optionalSource(
  '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/ExactAlarmRecoveryJobService.kt',
);
const coordinatorSource = optionalSource(
  '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/NotificationScheduleMutationCoordinator.kt',
);
const nativeModuleSource = optionalSource(
  '../modules/exact-alarm-access/android/src/main/java/app/dawaee/exactalarm/ExactAlarmAccessModule.kt',
);
const moduleManifestSource = optionalSource('../modules/exact-alarm-access/android/src/main/AndroidManifest.xml');
const nativeBindingSource = optionalSource('../modules/exact-alarm-access/index.ts');
const notificationsSource = optionalSource('../src/notifications/index.ts');

describe('Android exact-alarm recovery schedule serialization', () => {
  it('shares one native mutation gate between grant replay and JavaScript schedule changes', () => {
    expect(coordinatorSource).toContain('Semaphore(1, true)');
    expect(coordinatorSource).toContain('fun acquire()');
    expect(coordinatorSource).toContain('fun release()');
    expect(coordinatorSource).toContain('fun <T> withLease');

    const recoveryLease = recoveryJobSource.indexOf('NotificationScheduleMutationCoordinator.withInterruptibleLease');
    const recoverySnapshot = recoveryJobSource.indexOf('delegate.getAllScheduledNotifications()');
    const recoveryReplay = recoveryJobSource.indexOf('delegate.scheduleNotification(request)');
    expect(recoveryLease).toBeGreaterThan(-1);
    expect(recoverySnapshot).toBeGreaterThan(recoveryLease);
    expect(recoveryReplay).toBeGreaterThan(recoverySnapshot);

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

  it('does not hold an asynchronous broadcast open while waiting on the schedule-mutation lease', () => {
    const executableReceiverSource = executableKotlinLines(receiverSource).join('\n');
    expect(executableReceiverSource).not.toContain('goAsync()');
    expect(executableReceiverSource).not.toContain('thread(');
    expect(executableReceiverSource).toContain(
      'ExactAlarmRecoveryJobService.schedule(context.applicationContext)',
    );

    expect(recoveryJobSource).toContain('class ExactAlarmRecoveryJobService : JobService()');
    expect(recoveryJobSource).toContain('NotificationScheduleMutationCoordinator.withInterruptibleLease');
    expect(recoveryJobSource).toContain('jobFinished');
    expect(recoveryJobSource).toContain('onStopJob');
    expect(coordinatorSource).toContain('fun <T> withInterruptibleLease');

    expect(moduleManifestSource).toContain('ExactAlarmRecoveryJobService');
    expect(moduleManifestSource).toContain('android.permission.BIND_JOB_SERVICE');
  });
});
