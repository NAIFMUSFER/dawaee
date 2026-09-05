import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { api } from '../api/client.js';
import type { DoseView } from '../api/types.js';
import type { Locale } from '@dawaee/shared';
import { t } from '@dawaee/shared';

/**
 * Local notifications.
 *
 * Design decision that matters: the app schedules its own LOCAL notifications
 * from the cached prefetch window, in addition to server push. Push needs a
 * network; a local notification does not. On a phone with no signal at 8 PM,
 * the local one is what actually reminds the patient.
 *
 * Honest limits, stated rather than hidden:
 *  - iOS "critical alerts" (which bypass silent mode) need an Apple
 *    entitlement most medication apps are not granted. Without it the strongest
 *    available level is `timeSensitive`, which can break through Focus modes
 *    when the user permits it.
 *  - Android exact alarms need SCHEDULE_EXACT_ALARM, and from Android 13 the
 *    user can revoke it; the app detects that and tells them, because an
 *    inexact reminder for a medication is a real degradation.
 *
 * `expo-notifications` is loaded lazily so the module also works under Expo
 * Web, where notification scheduling is unavailable.
 */

export const MEDICATION_CHANNEL_ID = 'medication-critical';
export const MEDICATION_CATEGORY_ID = 'MEDICATION_REMINDER';

type NotificationsModule = typeof import('expo-notifications');

let cached: NotificationsModule | null | undefined;

async function load(): Promise<NotificationsModule | null> {
  if (cached !== undefined) return cached;
  if (Platform.OS === 'web') {
    cached = null;
    return null;
  }
  try {
    cached = (await import('expo-notifications')) as NotificationsModule;
  } catch {
    cached = null;
  }
  return cached;
}

export interface NotificationCapability {
  supported: boolean;
  permissionGranted: boolean;
  canScheduleExact: boolean;
  /** A user-facing key explaining what is degraded, if anything. */
  warningKey?: 'notifications.disabledTitle' | 'notifications.tokenInvalid';
}

export async function inspectCapability(): Promise<NotificationCapability> {
  const N = await load();
  if (!N) return { supported: false, permissionGranted: false, canScheduleExact: false };

  const settings = await N.getPermissionsAsync();
  const granted = settings.granted || settings.ios?.status === N.IosAuthorizationStatus.PROVISIONAL;
  return {
    supported: true,
    permissionGranted: granted,
    // Android exact-alarm capability is not directly queryable from Expo; the
    // scheduling call is what reveals it, and a failure is surfaced there.
    canScheduleExact: Platform.OS !== 'android' || granted,
    ...(granted ? {} : { warningKey: 'notifications.disabledTitle' as const }),
  };
}

export async function requestPermission(): Promise<boolean> {
  const N = await load();
  if (!N) return false;
  const res = await N.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: true, allowProvisional: false },
  });
  return res.granted;
}

export async function configureChannels(): Promise<void> {
  const N = await load();
  if (!N || Platform.OS !== 'android') return;
  await N.setNotificationChannelAsync(MEDICATION_CHANNEL_ID, {
    name: 'Medication reminders',
    importance: N.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 400, 200, 400],
    lockscreenVisibility: N.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: false,
    enableVibrate: true,
    showBadge: true,
  });
}

export async function configureCategories(locale: Locale): Promise<void> {
  const N = await load();
  if (!N) return;
  // Lock-screen actions: the patient can confirm without opening the app,
  // which is the difference between a tap and a forgotten dose.
  await N.setNotificationCategoryAsync(MEDICATION_CATEGORY_ID, [
    { identifier: 'TAKEN', buttonTitle: t(locale, 'today.taken'), options: { opensAppToForeground: false } },
    { identifier: 'SNOOZE', buttonTitle: t(locale, 'today.remindLater'), options: { opensAppToForeground: false } },
    { identifier: 'SKIP', buttonTitle: t(locale, 'today.skip'), options: { opensAppToForeground: true } },
  ]);
}

export interface ScheduleResult {
  scheduled: number;
  failed: number;
  exactAlarmsUnavailable: boolean;
}

/**
 * Rebuilds the local notification schedule from the cached doses.
 *
 * Everything is cancelled and re-created rather than diffed: the set is small
 * (a week of doses), and a stale reminder for a medication that was stopped is
 * far worse than a redundant reschedule.
 */
export async function rescheduleLocalNotifications(
  doses: DoseView[],
  locale: Locale,
  opts: { voiceEnabled?: boolean } = {},
): Promise<ScheduleResult> {
  const N = await load();
  if (!N) return { scheduled: 0, failed: 0, exactAlarmsUnavailable: false };

  await N.cancelAllScheduledNotificationsAsync();

  let scheduled = 0;
  let failed = 0;
  let exactAlarmsUnavailable = false;
  const now = Date.now();

  for (const dose of doses) {
    const at = new Date(dose.scheduledAt).getTime();
    if (at <= now) continue;
    if (['taken', 'taken_late', 'skipped', 'cancelled', 'missed'].includes(dose.status)) continue;

    const food = t(locale, `food.${dose.medication.foodInstruction}` as never);
    const body = t(locale, food ? 'reminder.bodyWithFood' : 'reminder.body', {
      medication: dose.medication.name,
      dose: `${dose.doseQuantity} ${dose.doseUnit}`,
      time: dose.scheduledLocalTime,
      food,
    });

    try {
      await N.scheduleNotificationAsync({
        content: {
          title: t(locale, 'reminder.title'),
          body,
          data: { doseId: dose.id, medicationId: dose.medicationId, kind: 'dose_reminder' },
          sound: 'default',
          categoryIdentifier: MEDICATION_CATEGORY_ID,
          interruptionLevel: 'timeSensitive',
          ...(opts.voiceEnabled ? { subtitle: t(locale, 'reminder.voice', {
            medication: dose.medication.name, dose: `${dose.doseQuantity} ${dose.doseUnit}`, food,
          }) } : {}),
        },
        trigger: {
          type: N.SchedulableTriggerInputTypes.DATE,
          date: new Date(dose.scheduledAt),
          channelId: MEDICATION_CHANNEL_ID,
        },
      });
      scheduled += 1;
    } catch (err) {
      failed += 1;
      if (String(err).includes('exact')) exactAlarmsUnavailable = true;
    }
  }

  return { scheduled, failed, exactAlarmsUnavailable };
}

/**
 * The device's Expo push token, or null if this device cannot receive one.
 *
 * `projectId` is not optional in a standalone build. Expo's SDK can infer it
 * while running under Expo Go, and cannot once the app is built for the store —
 * where it throws instead, which is exactly the environment a patient runs.
 * It is read from the manifest so there is one place it is configured.
 */
export async function registerPushToken(): Promise<string | null> {
  const N = await load();
  if (!N) return null;
  try {
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId
      ?? Constants.easConfig?.projectId;
    const token = await N.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return token.data;
  } catch {
    return null;
  }
}

/**
 * Asks for permission, obtains a token, and tells the server about it.
 *
 * Nothing called this before. The token was fetched by a function no screen
 * invoked and returned to nobody, so `push_tokens` stayed empty, and the
 * dispatcher's honest `no_active_device` was the end of every escalation —
 * the whole reminder chain terminated one step before a phone. It is called
 * on every start of a signed-in session, because a token can be reissued by
 * the OS at any time and a stale one is a silently missed dose.
 *
 * Returns false when this device simply cannot receive push (web, a simulator,
 * a refused permission). That is a real state the settings screen reports, not
 * an error to swallow.
 */
export async function syncPushRegistration(deviceId: string): Promise<boolean> {
  const N = await load();
  if (!N) return false;

  const settings = await N.getPermissionsAsync();
  const granted = settings.granted
    || settings.ios?.status === N.IosAuthorizationStatus.PROVISIONAL
    || (await requestPermission());
  if (!granted) return false;

  const token = await registerPushToken();
  if (!token) return false;

  await api.post('/v1/devices/push-token', {
    token,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    deviceId,
    appVersion: typeof Constants.expoConfig?.version === 'string' ? Constants.expoConfig.version : undefined,
  });
  return true;
}
