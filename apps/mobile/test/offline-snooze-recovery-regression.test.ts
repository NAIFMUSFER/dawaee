import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/client.js', () => ({
  api: { post: vi.fn() },
  NetworkError: class NetworkError extends Error {},
}));
vi.mock('../src/storage/secure-cache.js', () => ({
  clearSlot: vi.fn(),
  purgeAllSlots: vi.fn(),
  readSlot: vi.fn(),
  writeSlot: vi.fn(),
}));
vi.mock('../src/storage/low-stock-snooze.js', () => ({
  LOW_STOCK_SLOT: { plaintextKey: 'test.lowStock' },
  purgeSnoozes: vi.fn(),
}));
vi.mock('../src/storage/offline-bootstrap.js', () => ({
  OFFLINE_BOOTSTRAP_SLOT: { plaintextKey: 'test.bootstrap' },
  readOfflineBootstrap: vi.fn(),
  writeOfflineBootstrap: vi.fn(),
}));

import { applyQueuedToCache, type CachedSchedule, type QueuedAction } from '../src/storage/offline-queue.js';

const notificationsFile = fileURLToPath(new URL('../src/notifications/index.ts', import.meta.url));

describe('offline snooze reminder recovery', () => {
  it('derives a durable snooze deadline from the queued action', () => {
    const cache: CachedSchedule = {
      profileId: 'profile-a',
      cachedAt: '2026-09-15T08:00:00.000Z',
      timezone: 'Asia/Riyadh',
      doses: [{
        id: 'dose-a',
        scheduledAt: '2026-09-15T09:00:00.000Z',
        scheduledLocalDate: '2026-09-15',
        scheduledLocalTime: '12:00',
        medicationName: 'SYNTHETIC',
        doseQuantity: 1,
        doseUnit: 'tablet',
        foodInstruction: 'none',
        status: 'due',
      }],
    };
    const action: QueuedAction = {
      type: 'snoozed',
      doseOccurrenceId: 'dose-a',
      at: '2026-09-15T09:05:00.000Z',
      clientEventId: 'event-offline-snooze',
      minutes: 15,
    };

    const merged = applyQueuedToCache(cache, [action]);
    const dose = merged.doses[0] as CachedSchedule['doses'][number] & { snoozedUntil?: string | null };

    expect(dose.status).toBe('snoozed');
    expect(dose.snoozedUntil).toBe('2026-09-15T09:20:00.000Z');
  });

  it('rebuilds native reminders from queue-adjusted cache rather than stale cache alone', () => {
    const source = readFileSync(notificationsFile, 'utf8');
    const start = source.indexOf('export async function rebuildRemindersFromCache');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start);

    expect(body).toContain('readQueue');
    expect(body).toContain('applyQueuedToCache');
    expect(body).toContain('snoozedUntil');
  });
});
