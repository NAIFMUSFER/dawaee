import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  readCachedSchedule: vi.fn(),
  readQueue: vi.fn(),
  applyQueuedToCache: vi.fn(),
  cancelAll: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({ default: {} }));
// Keep the native boundary out of Node; the real scheduler/cache code still runs.
// Android capability changes are exercised in notification-schedule-races.cjs.
vi.mock('../modules/exact-alarm-access', () => ({
  canScheduleExactAlarms: vi.fn(() => false),
  withExactAlarmScheduleMutation: <T>(operation: () => Promise<T>) => operation(),
}));
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
  readQueue: io.readQueue,
  applyQueuedToCache: io.applyQueuedToCache,
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
  io.readQueue.mockReset().mockResolvedValue([]);
  io.applyQueuedToCache.mockReset().mockImplementation((snapshot, queue) => {
    expect(queue).toEqual([]); // Nonempty overlays must be explicit in their test.
    return snapshot;
  });
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

  it('schedules the queue-overlay snapshot rather than the raw cache', async () => {
    const snapshot = cache('RAW-CACHE');
    const snoozedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const queue = [{ type: 'snoozed', doseOccurrenceId: snapshot.doses[0]!.id }];
    const merged = {
      ...snapshot,
      doses: [{ ...snapshot.doses[0]!, status: 'snoozed', snoozedUntil }],
    };
    io.readCachedSchedule.mockResolvedValue(snapshot);
    io.readQueue.mockResolvedValue(queue);
    io.applyQueuedToCache.mockReturnValue(merged);

    const result = await notifications.rebuildRemindersFromCache(PROFILE, 'en', { showMedication: false });

    expect(io.readQueue).toHaveBeenCalledTimes(1);
    expect(io.applyQueuedToCache).toHaveBeenCalledWith(snapshot, queue);
    expect(result.scheduled).toBe(1);
    expect(io.schedule).toHaveBeenCalledTimes(1);
    const scheduled = io.schedule.mock.calls[0]![0];
    expect(scheduled.trigger.date.getTime()).toBe(Date.parse(snoozedUntil));
    expect(scheduled.content.title).toBe('PRIVATE');
  });

  it('logout wins while the older rebuild waits for the offline queue', async () => {
    const queueStarted = deferred<void>();
    const releaseQueue = deferred<unknown[]>();
    io.readCachedSchedule.mockResolvedValue(cache('STALE-NAMED-MEDICATION'));
    io.readQueue.mockImplementationOnce(() => {
      queueStarted.resolve();
      return releaseQueue.promise;
    });

    const stale = notifications.rebuildRemindersFromCache(PROFILE, 'en', { showMedication: true });
    await queueStarted.promise;
    await notifications.cancelAllLocalNotifications();
    releaseQueue.resolve([]);
    await stale;

    expect(io.applyQueuedToCache).not.toHaveBeenCalled();
    expect(io.schedule).not.toHaveBeenCalled();
    expect(io.cancelAll).toHaveBeenCalledTimes(1);
  });

  it('newer private intent wins over an older queue read that finishes later', async () => {
    const queueStarted = deferred<void>();
    const releaseQueue = deferred<unknown[]>();
    io.readCachedSchedule.mockResolvedValue(cache('NAMED-CACHE'));
    io.readQueue.mockImplementationOnce(() => {
      queueStarted.resolve();
      return releaseQueue.promise;
    });

    const stale = notifications.rebuildRemindersFromCache(
      PROFILE, 'en', { showMedication: true, voiceEnabled: true },
    );
    await queueStarted.promise;
    await notifications.rebuildRemindersFromCache(
      PROFILE, 'en', { showMedication: false, voiceEnabled: false },
    );
    releaseQueue.resolve([]);
    await stale;

    expect(io.applyQueuedToCache).toHaveBeenCalledTimes(1);
    expect(io.schedule).toHaveBeenCalledTimes(1);
    const scheduled = io.schedule.mock.calls[0]![0];
    expect(scheduled.content.title).toBe('PRIVATE');
    expect(scheduled.content.subtitle).toBe(undefined);
  });
});
