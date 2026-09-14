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
 * Decide whether returning from Android's exact-alarm special-access screen
 * requires repairing the local reminder schedule.
 *
 * Android cancels future exact alarms when SCHEDULE_EXACT_ALARM is revoked.
 * We therefore repair only an observed denied -> granted transition, and only
 * for the signed-in account's owner/self profile. A caregiver viewing another
 * patient must never schedule that patient's reminders on this phone.
 */
export function planExactAlarmGrantRecovery(
  input: ExactAlarmGrantRecoveryInput,
): ExactAlarmGrantRecoveryPlan | null {
  if (input.platform !== 'android' || !input.signedIn) return null;
  if (!input.previous || input.previous.canScheduleExact) return null;
  if (!input.current.supported || !input.current.permissionGranted || !input.current.canScheduleExact) return null;

  const selfOwner = input.profiles.find((profile) => profile.isSelf && profile.role === 'owner');
  if (!selfOwner) return null;

  return {
    profileId: selfOwner.id,
    locale: input.locale,
    options: {
      voiceEnabled: input.voiceEnabled,
      showMedication: input.showMedication,
    },
  };
}
