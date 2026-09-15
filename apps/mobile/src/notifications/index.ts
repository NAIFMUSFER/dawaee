import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { api } from '../api/client.js';
import type { DoseView } from '../api/types.js';
import type { Locale } from '@dawaee/shared';
import { groupedReminderText, reminderText, t } from '@dawaee/shared';
import {
  canScheduleExactAlarms as canScheduleExactAlarmsOnDevice,
  withExactAlarmScheduleMutation,
} from '../../modules/exact-alarm-access';
import { ACTION_SKIP, ACTION_SNOOZE, ACTION_TAKEN, applyNotificationAction, type ActionOutcome } from './actions.js';

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
  const canScheduleExact = Platform.OS !== 'android' ? true : granted && canScheduleExactAlarmsOnDevice();
  return {
    supported: true,
    permissionGranted: granted,
    canScheduleExact,
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
    lockscreenVisibility: N.AndroidNotificationVisibility.PRIVATE,
    bypassDnd: false,
    enableVibrate: true,
    showBadge: true,
  });
}

export async function configureCategories(locale: Locale): Promise<void> {
  const N = await load();
  if (!N) return;
  await N.setNotificationCategoryAsync(MEDICATION_CATEGORY_ID, [
    { identifier: ACTION_TAKEN, buttonTitle: t(locale, 'today.taken'), options: { opensAppToForeground: false } },
    { identifier: ACTION_SNOOZE, buttonTitle: t(locale, 'today.remindLater'), options: { opensAppToForeground: false } },
    { identifier: ACTION_SKIP, buttonTitle: t(locale, 'today.skip'), options: { opensAppToForeground: true } },
  ]);
}

export async function startNotificationActionListener(
  onHandled?: (outcome: ActionOutcome) => void,
): Promise<() => void> {
  const N = await load();
  if (!N) return () => undefined;

  const handle = async (response: {
    actionIdentifier: string;
    notification: { request: { content: { data: Record<string, unknown> } } };
  }): Promise<void> => {
    const outcome = await applyNotificationAction(
      response.actionIdentifier,
      response.notification.request.content.data ?? {},
    );
    if (outcome) {
      onHandled?.(outcome);
      // Expo keeps the cold-start response available until explicitly cleared.
      // Without consuming it, reopening the app can replay the same Snooze with
      // a brand-new clientEventId and move the reminder again.
      await N.clearLastNotificationResponseAsync?.();
    }
  };

  const last = await N.getLastNotificationResponseAsync();
  if (last) await handle(last as Parameters<typeof handle>[0]);

  const sub = N.addNotificationResponseReceivedListener((response) => {
    void handle(response as Parameters<typeof handle>[0]);
  });
  return () => sub.remove();
}

// Native scheduling/cancellation are asynchronous. A cancellation must run
// AFTER any already-started native write, or that write can recreate PHI-bearing
// reminders on a signed-out phone. New intent invalidates older loops at once;
// the serial tail makes the final native state belong to the newest operation.
// Android also takes the native exact-alarm recovery lease here so the system's
// permission-grant receiver cannot replay an older persisted snapshot across a
// newer logout, privacy change, or Today/cache rebuild.
let scheduleGeneration = 0;
let scheduleTail: Promise<void> = Promise.resolve();

/** Capture before asynchronous HTTP/cache work that carries rendered options.
 * New privacy/rebuild/cancel intent makes that caller's reminder work stale,
 * without discarding its otherwise valid clinical response. */
export function captureLocalReminderContext(): () => boolean {
  const generation = scheduleGeneration;
  return () => generation === scheduleGeneration;
}

function withScheduleMutation<T>(operation: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
  const generation = ++scheduleGeneration;
  const result = scheduleTail.then(() => withExactAlarmScheduleMutation(
    () => operation(() => generation === scheduleGeneration),
  ));
  scheduleTail = result.then(() => undefined, () => undefined);
  return result;
}

export async function cancelAllLocalNotifications(): Promise<void> {
  return withScheduleMutation(async () => {
    const N = await load();
    if (!N) return;
    await N.cancelAllScheduledNotificationsAsync();
  });
}

export interface ScheduleResult {
  scheduled: number;
  failed: number;
  exactAlarmsUnavailable: boolean;
}

function notificationAt(dose: DoseView): string {
  return dose.status === 'snoozed' && dose.snoozedUntil ? dose.snoozedUntil : dose.scheduledAt;
}

function notificationLocalTime(dose: DoseView): string {
  const at = notificationAt(dose);
  if (at === dose.scheduledAt || !dose.scheduledTimezone) return dose.scheduledLocalTime;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: dose.scheduledTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(at));
  } catch {
    return dose.scheduledLocalTime;
  }
}

function groupSchedulableDoses(doses: DoseView[], now: number): DoseView[][] {
  const groups = new Map<string, DoseView[]>();
  const seenDoseIds = new Set<string>();
  for (const dose of doses) {
    // `/v1/today` intentionally returns the local-day list AND a forward
    // prefetch window. A future dose later today therefore exists in both
    // arrays. The caller combines those arrays for offline scheduling, so the
    // notification layer must treat occurrence id as identity before it groups
    // by time; otherwise one real dose becomes a fake "2 medications" alert.
    if (seenDoseIds.has(dose.id)) continue;
    seenDoseIds.add(dose.id);

    const triggerAt = notificationAt(dose);
    const at = new Date(triggerAt).getTime();
    if (at <= now) continue;
    if (['taken', 'taken_late', 'skipped', 'cancelled', 'missed'].includes(dose.status)) continue;
    const bucket = groups.get(triggerAt);
    if (bucket) bucket.push(dose);
    else groups.set(triggerAt, [dose]);
  }
  return [...groups.values()].sort((a, b) => notificationAt(a[0]!).localeCompare(notificationAt(b[0]!)));
}

/**
 * Rebuilds the local notification schedule from the cached doses.
 *
 * Doses at the same instant are deliberately collapsed into one alert. Four
 * medicines at 08:00 must not vibrate four times or tempt an elderly patient
 * to press a single lock-screen action that could be misunderstood as applying
 * to all four. A grouped alert has no Taken/Snooze/Skip category: tapping it
 * opens Dawaee, where every dose remains independently confirmable.
 */
export async function rescheduleLocalNotifications(
  doses: DoseView[],
  locale: Locale,
  opts: { voiceEnabled?: boolean; showMedication?: boolean } = {},
): Promise<ScheduleResult> {
  return withScheduleMutation((isCurrent) => scheduleCurrentNotifications(doses, locale, opts, isCurrent));
}

async function scheduleCurrentNotifications(
  doses: DoseView[],
  locale: Locale,
  opts: { voiceEnabled?: boolean; showMedication?: boolean },
  isCurrent: () => boolean,
): Promise<ScheduleResult> {
  const N = await load();
  if (!N || !isCurrent()) return { scheduled: 0, failed: 0, exactAlarmsUnavailable: false };

  await N.cancelAllScheduledNotificationsAsync();

  let scheduled = 0;
  let failed = 0;
  // Expo Android intentionally falls back to an inexact alarm when the special
  // access is absent. A successful schedule call therefore does not prove exact
  // delivery. Read the OS source of truth up front so callers can disclose the
  // degradation even when Expo accepts the fallback without throwing.
  let exactAlarmsUnavailable = Platform.OS === 'android' && !canScheduleExactAlarmsOnDevice();
  const now = Date.now();

  for (const group of groupSchedulableDoses(doses, now)) {
    if (!isCurrent()) break;
    const first = group[0]!;
    const grouped = group.length > 1;
    const displayTime = notificationLocalTime(first);
    const text = grouped
      ? groupedReminderText({
          locale,
          showMedication: opts.showMedication,
          time: displayTime,
          medications: group.map((dose) => ({
            name: dose.medication.name,
            doseText: `${dose.doseQuantity} ${dose.doseUnit}`,
          })),
        })
      : reminderText({
          locale,
          showMedication: opts.showMedication,
          medicationName: first.medication.name,
          doseText: `${first.doseQuantity} ${first.doseUnit}`,
          time: displayTime,
          food: t(locale, `food.${first.medication.foodInstruction}` as never),
        });

    try {
      await N.scheduleNotificationAsync({
        content: {
          title: text.title,
          body: text.body,
          // The action handler needs only the occurrence id. Keeping the
          // medication id in OS notification metadata added a second stable,
          // health-linked identifier without any functional use.
          data: grouped
            ? { doseIds: group.map((dose) => dose.id), kind: 'dose_group_reminder' }
            : { doseId: first.id, kind: 'dose_reminder' },
          sound: 'default',
          ...(grouped ? {} : { categoryIdentifier: MEDICATION_CATEGORY_ID }),
          interruptionLevel: 'timeSensitive',
          ...(opts.voiceEnabled ? { subtitle: text.voice } : {}),
        },
        trigger: {
          type: N.SchedulableTriggerInputTypes.DATE,
          date: new Date(notificationAt(first)),
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

export async function rebuildRemindersFromCache(
  profileId: string | null,
  locale: Locale,
  opts: { voiceEnabled?: boolean; showMedication?: boolean },
): Promise<ScheduleResult> {
  const empty: ScheduleResult = { scheduled: 0, failed: 0, exactAlarmsUnavailable: false };
  if (!profileId) return empty;

  // Reserve intent BEFORE reading storage. Merely observing the generation
  // lets two cached rebuilds share it: the older read can finish first and
  // suppress a newer privacy choice. Storage must stay outside scheduleTail so
  // cancellation never waits on a stalled cache read.
  const expectedGeneration = ++scheduleGeneration;
  const { readCachedSchedule } = await import('../storage/offline-queue.js');
  const cache = await readCachedSchedule(profileId);
  if (!cache || expectedGeneration !== scheduleGeneration) return empty;

  return rescheduleLocalNotifications(
    cache.doses.map((d) => ({
      id: d.id,
      scheduledAt: d.scheduledAt,
      scheduledLocalTime: d.scheduledLocalTime,
      status: d.status,
      doseQuantity: d.doseQuantity,
      doseUnit: d.doseUnit,
      medicationId: '',
      medication: { name: d.medicationName, foodInstruction: d.foodInstruction },
    })) as unknown as DoseView[],
    locale,
    opts,
  );
}