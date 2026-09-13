import { describe, expect, it } from 'vitest';
import {
  canUndo, confirmTaken, DEFAULT_THRESHOLDS, deriveStatus, EARLY_CONFIRMATION_WINDOW_MINUTES,
  isDueForReminder, isRecorded, isTerminal, MAX_SNOOZES, skip, snooze,
  VOICE_CONFIDENCE_FLOOR, viewOf,
} from '../src/dose-status.js';
import type { DoseOccurrence } from '@dawaee/shared';

const SCHEDULED = '2026-09-02T17:00:00.000Z'; // 20:00 Riyadh
const th = { lateAfterMinutes: 15, missedAfterMinutes: 120, lateConfirmationWindowMinutes: 1440 };

const occ = (o: Partial<DoseOccurrence> = {}) =>
  ({
    id: 'dose-1',
    status: 'upcoming',
    scheduledAt: SCHEDULED,
    snoozedUntil: null,
    notifiedAt: null,
    confirmedAt: null,
    snoozeCount: 0,
    ...o,
  }) as DoseOccurrence;

const minutesBefore = (n: number) =>
  new Date(new Date(SCHEDULED).getTime() - n * 60_000);

describe('deriveStatus', () => {
  it('is upcoming before the scheduled time', () => {
    expect(deriveStatus(occ(), new Date('2026-09-02T16:59:00Z'), th)).toBe('upcoming');
  });
  it('is due at the scheduled time when not yet notified', () => {
    expect(deriveStatus(occ(), new Date('2026-09-02T17:00:00Z'), th)).toBe('due');
  });
  it('is pending_confirmation once a reminder went out', () => {
    expect(deriveStatus(occ({ notifiedAt: SCHEDULED }), new Date('2026-09-02T17:05:00Z'), th))
      .toBe('pending_confirmation');
  });
  it('is snoozed while the snooze is live', () => {
    const o = occ({ notifiedAt: SCHEDULED, snoozedUntil: '2026-09-02T17:30:00.000Z' });
    expect(deriveStatus(o, new Date('2026-09-02T17:15:00Z'), th)).toBe('snoozed');
    expect(deriveStatus(o, new Date('2026-09-02T17:31:00Z'), th)).toBe('pending_confirmation');
  });
  it('becomes missed after the missed threshold even if snoozed', () => {
    const o = occ({ snoozedUntil: '2026-09-02T23:00:00.000Z' });
    expect(deriveStatus(o, new Date('2026-09-02T19:01:00Z'), th)).toBe('missed');
  });
  it('never moves a recorded status', () => {
    for (const s of ['taken', 'taken_late', 'skipped', 'cancelled'] as const) {
      expect(deriveStatus(occ({ status: s }), new Date('2027-01-01T00:00:00Z'), th)).toBe(s);
    }
  });
  it('shows the truth after the phone was off for two days', () => {
    expect(deriveStatus(occ(), new Date('2026-09-04T09:00:00Z'), th)).toBe('missed');
  });
});

describe('confirmTaken', () => {
  const base = { occurrence: occ(), thresholds: th, method: 'app' as const };

  it('records on-time when inside the late grace period', () => {
    const at = new Date('2026-09-02T17:10:00Z');
    const r = confirmTaken({ ...base, at, now: at });
    expect(r.status).toBe('taken');
    expect(r.minutesLate).toBe(10);
  });

  it('allows a small early confirmation at the safety boundary', () => {
    const at = minutesBefore(EARLY_CONFIRMATION_WINDOW_MINUTES);
    const r = confirmTaken({ ...base, at, now: at });
    expect(r.status).toBe('taken');
    expect(r.minutesLate).toBe(0);
    expect(r.confirmedAt.toISOString()).toBe(at.toISOString());
  });

  it('refuses a confirmation even one minute before the early safety window', () => {
    const at = minutesBefore(EARLY_CONFIRMATION_WINDOW_MINUTES + 1);
    expect(() => confirmTaken({ ...base, at, now: at })).toThrow(/too early/i);
  });

  it('refuses the production-class failure of recording a future dose many hours early', () => {
    const at = new Date('2026-09-02T08:00:00Z');
    expect(() => confirmTaken({ ...base, at, now: at })).toThrow(/too early/i);
  });

  it('records taken_late past the grace period', () => {
    const at = new Date('2026-09-02T17:25:00Z');
    const r = confirmTaken({ ...base, at, now: at });
    expect(r.status).toBe('taken_late');
    expect(r.minutesLate).toBe(25);
  });

  it('lets a missed dose still be recorded late, inside the confirmation window', () => {
    const at = new Date('2026-09-02T21:00:00Z');
    const r = confirmTaken({ ...base, occurrence: occ({ status: 'missed' }), at, now: at });
    expect(r.status).toBe('taken_late');
  });

  it('refuses to record a dose older than the confirmation window', () => {
    const at = new Date('2026-09-04T17:00:00Z');
    expect(() => confirmTaken({ ...base, at, now: at })).toThrow(/too old/i);
  });

  it('refuses a second confirmation', () => {
    const at = new Date('2026-09-02T17:05:00Z');
    expect(() => confirmTaken({ ...base, occurrence: occ({ status: 'taken' }), at, now: at }))
      .toThrow(/already recorded/i);
  });

  it('clamps a client clock running ahead of the server', () => {
    const r = confirmTaken({
      ...base,
      at: new Date('2026-09-02T18:00:00Z'),
      now: new Date('2026-09-02T17:05:00Z'),
    });
    expect(r.minutesLate).toBe(5);
    expect(r.status).toBe('taken');
  });

  it('rejects a low-confidence voice confirmation', () => {
    const at = new Date('2026-09-02T17:05:00Z');
    expect(() =>
      confirmTaken({ ...base, at, now: at, method: 'voice', voiceConfidence: VOICE_CONFIDENCE_FLOOR - 0.01 }),
    ).toThrow(/confidence/i);
  });

  it('accepts a high-confidence voice confirmation', () => {
    const at = new Date('2026-09-02T17:05:00Z');
    expect(confirmTaken({ ...base, at, now: at, method: 'voice', voiceConfidence: 0.93 }).status).toBe('taken');
  });
});

describe('snooze', () => {
  it('pushes the reminder out by the requested minutes', () => {
    const now = new Date('2026-09-02T17:02:00Z');
    const r = snooze(occ({ snoozeCount: 0 }), 10, now);
    expect(r.snoozedUntil.toISOString()).toBe('2026-09-02T17:12:00.000Z');
    expect(r.snoozeCount).toBe(1);
  });
  it('allows snooze at the same small early boundary as confirmation', () => {
    expect(snooze(occ(), 10, minutesBefore(EARLY_CONFIRMATION_WINDOW_MINUTES)).snoozeCount).toBe(1);
  });
  it('refuses snooze one minute before the safety boundary', () => {
    expect(() => snooze(occ(), 10, minutesBefore(EARLY_CONFIRMATION_WINDOW_MINUTES + 1)))
      .toThrow(/too early/i);
  });
  it('refuses a stale client snoozing tomorrow many hours early', () => {
    expect(() => snooze(occ(), 10, new Date('2026-09-02T08:00:00Z'))).toThrow(/too early/i);
  });
  it('caps repeated snoozing', () => {
    expect(() => snooze(occ({ snoozeCount: MAX_SNOOZES }), 10, new Date(SCHEDULED))).toThrow(/limit/i);
  });
  it('refuses to snooze a recorded dose', () => {
    expect(() => snooze(occ({ status: 'taken', snoozeCount: 0 }), 10, new Date(SCHEDULED))).toThrow(/already recorded/i);
  });
});

describe('skip and undo', () => {
  it('skips an open dose', () => {
    expect(skip(occ(), new Date(SCHEDULED)).status).toBe('skipped');
  });
  it('allows skip at the same small early boundary as confirmation', () => {
    expect(skip(occ(), minutesBefore(EARLY_CONFIRMATION_WINDOW_MINUTES)).status).toBe('skipped');
  });
  it('refuses skip one minute before the safety boundary', () => {
    expect(() => skip(occ(), minutesBefore(EARLY_CONFIRMATION_WINDOW_MINUTES + 1))).toThrow(/too early/i);
  });
  it('refuses a stale client skipping tomorrow many hours early', () => {
    expect(() => skip(occ(), new Date('2026-09-02T08:00:00Z'))).toThrow(/too early/i);
  });
  it('refuses to skip an already-recorded dose', () => {
    expect(() => skip(occ({ status: 'taken' }), new Date(SCHEDULED))).toThrow(/already recorded/i);
  });
  it('still lets a missed dose be marked skipped retroactively', () => {
    expect(skip(occ({ status: 'missed' }), new Date('2026-09-02T21:00:00Z')).status).toBe('skipped');
  });
  it('refuses to snooze a missed dose', () => {
    expect(() => snooze(occ({ status: 'missed', snoozeCount: 0 }), 10, new Date('2026-09-02T21:00:00Z'))).toThrow(/already missed/i);
  });
  it('allows undo inside the window only', () => {
    const confirmedAt = '2026-09-02T17:05:00.000Z';
    expect(canUndo(occ({ status: 'taken', confirmedAt }), new Date('2026-09-02T17:12:00Z'))).toBe(true);
    expect(canUndo(occ({ status: 'taken', confirmedAt }), new Date('2026-09-02T17:20:00Z'))).toBe(false);
    expect(canUndo(occ({ status: 'missed', confirmedAt: null }), new Date('2026-09-02T17:06:00Z'))).toBe(false);
  });
});

describe('reminder eligibility and views', () => {
  it('flags a due dose for the reminder job and not a snoozed one', () => {
    expect(isDueForReminder(occ(), new Date('2026-09-02T17:00:00Z'), th)).toBe(true);
    expect(isDueForReminder(occ({ snoozedUntil: '2026-09-02T17:30:00.000Z' }), new Date('2026-09-02T17:10:00Z'), th))
      .toBe(false);
  });
  it('reports how late a taken dose was', () => {
    const v = viewOf(occ({ status: 'taken_late', confirmedAt: '2026-09-02T17:25:00.000Z' }), new Date('2026-09-02T18:00:00Z'), th);
    expect(v.status).toBe('taken_late');
    expect(v.minutesLate).toBe(25);
  });
});

describe('defaults', () => {
  it('exposes sane defaults and terminal set', () => {
    expect(DEFAULT_THRESHOLDS.missedAfterMinutes).toBeGreaterThan(DEFAULT_THRESHOLDS.lateAfterMinutes);
    expect(EARLY_CONFIRMATION_WINDOW_MINUTES).toBeGreaterThan(0);
    expect(EARLY_CONFIRMATION_WINDOW_MINUTES).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.lateAfterMinutes);
    expect(isTerminal('taken')).toBe(true);
    expect(isTerminal('missed')).toBe(true);
    expect(isTerminal('due')).toBe(false);
    expect(isRecorded('missed')).toBe(false);
    expect(isRecorded('skipped')).toBe(true);
  });
});
