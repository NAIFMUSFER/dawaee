import { requireOptionalNativeModule } from 'expo';

type ExactAlarmAccessNativeModule = {
  canScheduleExactAlarms(): boolean;
  openExactAlarmSettings(): boolean;
  acquireNotificationScheduleMutation?: () => Promise<void>;
  releaseNotificationScheduleMutation?: () => void;
};

const nativeModule = requireOptionalNativeModule('DawaeeExactAlarmAccess') as ExactAlarmAccessNativeModule | null;

/**
 * Returns the Android platform source of truth for exact-alarm special access.
 * Fail closed when the native module is unavailable (for example Expo Go), so
 * release UI never claims exact delivery without OS evidence.
 */
export function canScheduleExactAlarms(): boolean {
  return nativeModule?.canScheduleExactAlarms() ?? false;
}

/**
 * Opens Android's app-scoped "Alarms & reminders" special-access screen.
 * Returns false when the native module cannot launch that screen; callers may
 * fall back to ordinary application settings.
 */
export function openExactAlarmSettings(): boolean {
  return nativeModule?.openExactAlarmSettings() ?? false;
}

/**
 * Runs one JavaScript notification-schedule mutation under the same native
 * process-local lease used by ExactAlarmPermissionReceiver. On iOS/web, Expo Go,
 * or an older native binary that does not expose the lease methods, preserve the
 * existing behavior rather than failing an OTA update.
 */
export async function withExactAlarmScheduleMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (!nativeModule?.acquireNotificationScheduleMutation || !nativeModule.releaseNotificationScheduleMutation) {
    return operation();
  }

  await nativeModule.acquireNotificationScheduleMutation();
  try {
    return await operation();
  } finally {
    nativeModule.releaseNotificationScheduleMutation();
  }
}
