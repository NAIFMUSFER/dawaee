import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  readCachedSchedule: vi.fn(),
  cancelAll: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('../src/api/client.js', () => ({ api: { post: vi.fn() } }));
vi.mock('../src/notifications/actions.js', () => ({
  ACTION_SKIP: 'SKIP',
  ACTION_SNOOZE: 'SNOOZE',
  ACTION_TAKEN: 'TAKEN',
  applyNotificationAction: vi.fn(async () => null),
}));
vi.mock('@dawaee/shared', () => ({
  t: (_locale: string, key: string) => key,
  reminderText: ({ showMedication, medicationName }: { showMedication?: boolean; medicationName: string }) => ({
    title: showMedication ? medicationName : 'PRIVATE',
    body: showMedication ? medicationName : 'GENERIC',
    voice: showMedication ? medicationName : 'GENERIC',
  }),
  groupedReminderText: () => ({ title: 'GROUP', body: 'GROUP', voice: 'GROUP' }),
}));
vi.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DATE: 'date' },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  cancelAllScheduledNotificationsAsync: io.cancelAll,
  scheduleNotificationAsync: io.schedule,
}));
vi.mock('../src/storage/offline-queue.js', () => ({
  readCachedSchedule: io.readCachedSchedule,
}));

const PROFILE = '11111111-2222-4333-8444-555555555555';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function cache(medicationName: string) {
  return {
    profileId: PROFILE,
    cachedAt: '2026-09-09T05:00:00.000Z',
    timezone: 'Asia/Riyadh',
    doses: [{
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      scheduledLocalTime: '10:00',
      scheduledLocalDate: '2026-09-09',
      medicationName,
      doseQuantity: 1,
      doseUnit: 'tablet',
      foodInstruction: 'no_preference',
      status: 'upcoming',
    }],
  };
}

let notifications: typeof import('../src/notifications/index.js');

beforeEach(async () => {
  vi.resetModules();
  io.readCachedSchedule.mockReset();
  io.cancelAll.mockReset().mockResolvedValue(undefined);
  io.schedule.mockReset().mockResolvedValue('native-id');
  notifications = await import('../src/notifications/index.js');
});

describe('cached reminder rebuild cannot cross a later privacy boundary', () => {
  it('positive control: a current cache rebuild still schedules the cached dose', async () => {
    io.readCachedSchedule.mockResolvedValue(cache('CURRENT-MEDICATION'));

    const result = await notifications.rebuildRemindersFromCache(
      PROFILE,
      'en',
      { showMedication: true, voiceEnabled: false },
    );

    expect(result.scheduled).toBe(1);
    expect(io.schedule).toHaveBeenCalledTimes(1);
  });

  it('logout cancellation wins even when an older cache read finishes afterwards', async () => {
    const readStarted = deferred<void>();
    const releaseRead = deferred<ReturnType<typeof cache>>();
    io.readCachedSchedule.mockImplementationOnce(async () => {
      readStarted.resolve();
      return releaseRead.promise;
    });

    const staleRebuild = notifications.rebuildRemindersFromCache(
      PROFILE,
      'en',
      { showMedication: true, voiceEnabled: true },
    );
    await readStarted.promise;

    await notifications.cancelAllLocalNotifications();
    releaseRead.resolve(cache('STALE-NAMED-MEDICATION'));
    await staleRebuild;

    expect(io.schedule).not.toHaveBeenCalled();
  });

  it('a newer explicit schedule wins over a delayed cache rebuild', async () => {
    const readStarted = deferred<void>();
    const releaseRead = deferred<ReturnType<typeof cache>>();
    io.readCachedSchedule.mockImplementationOnce(async () => {
      readStarted.resolve();
      return releaseRead.promise;
    });

    const staleRebuild = notifications.rebuildRemindersFromCache(
      PROFILE,
      'en',
      { showMedication: true, voiceEnabled: true },
    );
    await readStarted.promise;

    await notifications.rescheduleLocalNotifications([
      {
        id: 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb',
        medicationId: '99999999-8888-4777-8666-555555555555',
        scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        scheduledLocalTime: '11:00',
        status: 'upcoming',
        doseQuantity: 1,
        doseUnit: 'tablet',
        medication: { name: 'NEW-PRIVATE-SCHEDULE', foodInstruction: 'no_preference' },
      } as never,
    ], 'en', { showMedication: false, voiceEnabled: false });

    releaseRead.resolve(cache('STALE-NAMED-MEDICATION'));
    await staleRebuild;

    expect(io.schedule).toHaveBeenCalledTimes(1);
    const scheduled = io.schedule.mock.calls[0]?.[0] as { content?: { title?: string } } | undefined;
    expect(scheduled?.content?.title).toBe('PRIVATE');
  });
});
