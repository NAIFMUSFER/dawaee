export interface ExactAlarmCapabilitySnapshot {
  supported: boolean;
  permissionGranted: boolean;
  canScheduleExact: boolean;
}

export interface ExactAlarmRecoveryProfile {
  id: string;
  isSelf: boolean;
  role: string;
}

export interface ExactAlarmGrantRecoveryInput {
  platform: string;
  previous: ExactAlarmCapabilitySnapshot | null;
  current: ExactAlarmCapabilitySnapshot;
  signedIn: boolean;
  profiles: readonly ExactAlarmRecoveryProfile[];
  locale: 'ar' | 'en';
  voiceEnabled: boolean;
  showMedication: boolean;
}

export interface ExactAlarmGrantRecoveryPlan {
  profileId: string;
  locale: 'ar' | 'en';
  options: {
    voiceEnabled: boolean;
    showMedication: boolean;
  };
}

/**
 * Android exact-alarm grant recovery is owned by the native
 * ExactAlarmPermissionReceiver.
 *
 * The system broadcasts the grant while the app process may be stopped. The
 * receiver restores the already-persisted Expo notification requests directly.
 * Creating a second JavaScript rebuild plan when the settings screen later
 * returns to the foreground would race that native replay: JS can cancel and
 * rebuild while the receiver is still replaying an older snapshot, allowing a
 * stale or duplicate request to be written after the current schedule.
 *
 * Keep this compatibility seam returning null while the settings integration
 * still calls it. AppState is allowed to refresh capability/UI state, but it
 * must not mutate the schedule after the grant broadcast.
 */
export function planExactAlarmGrantRecovery(
  input: ExactAlarmGrantRecoveryInput,
): ExactAlarmGrantRecoveryPlan | null {
  void input;
  return null;
}
