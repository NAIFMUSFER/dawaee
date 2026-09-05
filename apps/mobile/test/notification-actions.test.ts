import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tapping a button on the reminder itself.
 *
 * Three buttons — Taken, Remind me later, Skip — were registered on every
 * medication reminder, two of them declared not to open the app, and NOTHING
 * anywhere read the response. The patient tapped "Taken" on the lock screen,
 * the notification vanished, and the dose stayed unconfirmed: marked missed,
 * then escalated to their family. The gesture meant to prevent a false alarm
 * was the one producing it.
 *
 * These tests exist because that failure is invisible from the outside. The
 * buttons still render, the tap is still accepted by the OS, and nothing
 * reports an error — the only observable difference is a request that is or is
 * not made.
 */

const post = vi.fn();
const enqueue = vi.fn();

class NetworkError extends Error {}

vi.mock('../src/api/client.js', () => ({
  api: { post: (...args: unknown[]) => post(...args) },
  NetworkError,
  getDeviceId: async () => 'device-under-test',
}));

vi.mock('../src/storage/offline-queue.js', () => ({
  enqueue: (...args: unknown[]) => enqueue(...args),
  newClientEventId: () => 'evt-fixed-for-test',
}));

const { applyNotificationAction } = await import('../src/notifications/actions.js');

beforeEach(() => {
  post.mockReset();
  enqueue.mockReset();
  post.mockResolvedValue({});
});

const DOSE = { doseId: 'dose-1', kind: 'dose_reminder' };

describe('a tap on the reminder', () => {
  it('records "Taken" against the dose the notification names', async () => {
    const outcome = await applyNotificationAction('TAKEN', DOSE);

    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/v1/doses/dose-1/taken');
    expect(body.method).toBe('push_action');
    expect(body.deviceId).toBe('device-under-test');
    expect(outcome).toEqual({ action: 'taken', doseId: 'dose-1', synced: true });
  });

  it('records "Skip"', async () => {
    await applyNotificationAction('SKIP', DOSE);
    expect(post.mock.calls[0]?.[0]).toBe('/v1/doses/dose-1/skip');
  });

  it('snoozes with a concrete number of minutes', async () => {
    await applyNotificationAction('SNOOZE', DOSE);
    const [path, body] = post.mock.calls[0] as [string, { minutes: number }];
    expect(path).toBe('/v1/doses/dose-1/snooze');
    expect(body.minutes).toBeGreaterThan(0);
  });

  /**
   * The tap most likely to happen on a phone with no signal is the one at 8pm
   * in a basement. Losing it would recreate the original bug for exactly the
   * patients least able to notice.
   */
  it('queues the confirmation when the request never reaches the server', async () => {
    post.mockRejectedValue(new NetworkError('offline'));

    const outcome = await applyNotificationAction('TAKEN', DOSE);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ type: 'taken', doseOccurrenceId: 'dose-1' });
    expect(outcome?.synced).toBe(false);
  });

  /**
   * A refusal is an answer. Queueing it would replay the same rejected write
   * on every sync, forever.
   */
  it('does not queue a request the server actively refused', async () => {
    post.mockRejectedValue(new Error('409 already resolved'));

    const outcome = await applyNotificationAction('TAKEN', DOSE);

    expect(enqueue).not.toHaveBeenCalled();
    expect(outcome?.synced).toBe(false);
  });

  it('ignores a notification that names no dose, and any other action', async () => {
    expect(await applyNotificationAction('TAKEN', { kind: 'low_stock' })).toBeNull();
    expect(await applyNotificationAction('SOMETHING_ELSE', DOSE)).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});
