import { describe, expect, it } from 'vitest';
import { applyQueuedToDoses, cacheDose } from '../src/storage/dose-cache.js';
import type { DoseView } from '../src/api/types.js';
import type { QueuedAction } from '../src/storage/offline-queue.js';

const dose = { id: 'dose-a', medicationId: 'med-a', scheduledAt: '2026-09-19T12:00:00Z',
  scheduledTimezone: 'Asia/Riyadh', scheduledLocalDate: '2026-09-19', scheduledLocalTime: '15:00',
  status: 'due', snoozedUntil: null, confirmedAt: null, doseQuantity: 1, doseUnit: 'tablet',
  thresholds: { lateAfterMinutes: 15, missedAfterMinutes: 120 },
  medication: { name: 'Synthetic', imageKey: 'synthetic-image', foodInstruction: 'no_preference' },
} as DoseView;
const at = '2026-09-19T12:03:00Z';
const action = (type: 'taken' | 'skipped'): QueuedAction => ({ type, at,
  doseOccurrenceId: dose.id, clientEventId: 'synthetic-event' });

describe('durable pending-dose display over an older online response', () => {
  for (const type of ['taken', 'skipped'] as const) {
    it(`retains ${type} and its actual action time until acknowledgement`, () => {
      expect(applyQueuedToDoses([dose], [action(type)])[0]).toMatchObject({ status: type, confirmedAt: at });
      expect(dose.status).toBe('due');
      expect(applyQueuedToDoses([dose], [])[0]).toBe(dose);
    });
  }
  it('keeps a snooze deadline anchored to the tap, not the later cache/HTTP read', () => {
    const queued: QueuedAction = { type: 'snoozed', at, minutes: 5,
      doseOccurrenceId: dose.id, clientEventId: 'synthetic-snooze' };
    expect(applyQueuedToDoses([dose], [queued])[0]).toMatchObject({ status: 'snoozed', snoozedUntil: '2026-09-19T12:08:00.000Z' });
    expect(applyQueuedToDoses([{ ...dose, id: 'another' }], [queued])[0]!.status).toBe('due');
  });
  it('lets the latest local intent win for one occurrence', () => {
    expect(applyQueuedToDoses([dose], [action('taken'), action('skipped')])[0]!.status).toBe('skipped');
  });
  it('retains timezone, photo identity, missed threshold and snooze deadline in encrypted cache data', () => {
    const cached = cacheDose({ ...dose, status: 'snoozed', snoozedUntil: '2026-09-19T12:08:00Z' });
    expect(cached).toMatchObject({ scheduledTimezone: 'Asia/Riyadh', medicationId: 'med-a',
      imageKey: 'synthetic-image', thresholds: dose.thresholds, snoozedUntil: '2026-09-19T12:08:00Z' });
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: cached.scheduledTimezone, hour: '2-digit', minute: '2-digit' })
      .format(new Date(cached.scheduledAt))).toBe('15:00');
  });
});
