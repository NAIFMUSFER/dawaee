import { requireOptionalNativeModule } from 'expo';

type ExactAlarmAccessNativeModule = {
  canScheduleExactAlarms(): boolean;
  openExactAlarmSettings(): boolean;
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
