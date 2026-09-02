import { describe, expect, it } from 'vitest';
import { consecutiveMissed, dailyBreakdown, summarizeAdherence } from '../src/adherence.js';
import type { DoseOccurrence, DoseStatus } from '@dawaee/shared';

const th = { lateAfterMinutes: 15, missedAfterMinutes: 120 };
const NOW = new Date('2026-09-09T12:00:00Z');

function o(status: DoseStatus, scheduledAt: string, confirmedAt: string | null = null): DoseOccurrence {
  return { status, scheduledAt, confirmedAt, snoozedUntil: null, notifiedAt: null } as DoseOccurrence;
}

describe('summarizeAdherence', () => {
  it('reproduces the brief’s 7-day example', () => {
    // 28 scheduled: 23 on time, 2 late, 3 missed.
    const occurrences: DoseOccurrence[] = [
      ...Array.from({ length: 23 }, (_, i) => o('taken', `2026-09-0${(i % 7) + 1}T08:00:00.000Z`, `2026-09-0${(i % 7) + 1}T08:05:00.000Z`)),
      ...Array.from({ length: 2 }, () => o('taken_late', '2026-09-03T08:00:00.000Z', '2026-09-03T08:40:00.000Z')),
      ...Array.from({ length: 3 }, () => o('missed', '2026-09-04T08:00:00.000Z')),
    ];
    const s = summarizeAdherence({ occurrences, now: NOW, thresholds: th, from: '2026-09-01', to: '2026-09-07' });
    expect(s.scheduled).toBe(28);
    expect(s.taken).toBe(25);
    expect(s.takenLate).toBe(2);
    expect(s.missed).toBe(3);
    expect(s.adherencePercent).toBe(89.3);
  });

  it('matches the daily-summary example: 8 scheduled, 7 taken, 1 missed = 87.5%', () => {
    const occurrences = [
      ...Array.from({ length: 7 }, () => o('taken', '2026-09-02T05:00:00.000Z', '2026-09-02T05:02:00.000Z')),
      o('missed', '2026-09-02T19:00:00.000Z'),
    ];
    const s = summarizeAdherence({ occurrences, now: NOW, thresholds: th, from: '2026-09-02', to: '2026-09-02' });
    expect(s.adherencePercent).toBe(87.5);
  });

  it('does not let future doses drag the percentage down', () => {
    const occurrences = [
      o('taken', '2026-09-09T05:00:00.000Z', '2026-09-09T05:01:00.000Z'),
      o('upcoming', '2026-09-09T19:00:00.000Z'),
    ];
    const s = summarizeAdherence({ occurrences, now: NOW, thresholds: th, from: '2026-09-09', to: '2026-09-09' });
    expect(s.pending).toBe(1);
    expect(s.adherencePercent).toBe(100);
  });

  it('returns null rather than 0% when nothing has resolved yet', () => {
    const s = summarizeAdherence({
      occurrences: [o('upcoming', '2026-09-09T19:00:00.000Z')],
      now: NOW, thresholds: th, from: '2026-09-09', to: '2026-09-09',
    });
    expect(s.adherencePercent).toBeNull();
  });

  it('excludes cancelled doses from the scheduled count', () => {
    const s = summarizeAdherence({
      occurrences: [o('taken', '2026-09-01T05:00:00.000Z', '2026-09-01T05:01:00.000Z'), o('cancelled', '2026-09-01T19:00:00.000Z')],
      now: NOW, thresholds: th, from: '2026-09-01', to: '2026-09-01',
    });
    expect(s.scheduled).toBe(1);
    expect(s.adherencePercent).toBe(100);
  });

  it('recomputes missed status from the clock, not from stale rows', () => {
    // Row still says "upcoming" but the time has long passed.
    const s = summarizeAdherence({
      occurrences: [o('upcoming', '2026-09-01T05:00:00.000Z')],
      now: NOW, thresholds: th, from: '2026-09-01', to: '2026-09-01',
    });
    expect(s.missed).toBe(1);
    expect(s.adherencePercent).toBe(0);
  });

  it('counts a skipped dose as resolved but not taken', () => {
    const s = summarizeAdherence({
      occurrences: [o('taken', '2026-09-01T05:00:00.000Z', '2026-09-01T05:01:00.000Z'), o('skipped', '2026-09-01T19:00:00.000Z')],
      now: NOW, thresholds: th, from: '2026-09-01', to: '2026-09-01',
    });
    expect(s.adherencePercent).toBe(50);
  });
});

describe('dailyBreakdown', () => {
  it('buckets by the patient’s local date, not UTC', () => {
    // 22:00 Riyadh on Sep 2 is 19:00Z the same day; 01:00 Riyadh Sep 3 is 22:00Z Sep 2.
    const rows = dailyBreakdown(
      [
        o('taken', '2026-09-02T19:00:00.000Z', '2026-09-02T19:01:00.000Z'),
        o('taken', '2026-09-02T22:00:00.000Z', '2026-09-02T22:01:00.000Z'),
      ],
      NOW, th, 'Asia/Riyadh',
    );
    expect(rows.map((r) => r.date)).toEqual(['2026-09-02', '2026-09-03']);
  });

  it('computes a per-day percentage', () => {
    const rows = dailyBreakdown(
      [
        o('taken', '2026-09-02T05:00:00.000Z', '2026-09-02T05:01:00.000Z'),
        o('missed', '2026-09-02T11:00:00.000Z'),
      ],
      NOW, th, 'Asia/Riyadh',
    );
    expect(rows[0]!.adherencePercent).toBe(50);
  });
});

describe('consecutiveMissed', () => {
  it('counts the streak ending at the most recent resolved dose', () => {
    const rows = [
      o('taken', '2026-09-01T05:00:00.000Z'),
      o('missed', '2026-09-01T11:00:00.000Z'),
      o('missed', '2026-09-01T19:00:00.000Z'),
    ];
    expect(consecutiveMissed(rows, NOW, th)).toBe(2);
  });

  it('resets the streak when a later dose was taken', () => {
    const rows = [
      o('missed', '2026-09-01T05:00:00.000Z'),
      o('taken', '2026-09-01T11:00:00.000Z', '2026-09-01T11:01:00.000Z'),
    ];
    expect(consecutiveMissed(rows, NOW, th)).toBe(0);
  });

  it('ignores doses that have not resolved yet', () => {
    const rows = [o('missed', '2026-09-01T05:00:00.000Z'), o('upcoming', '2026-09-09T19:00:00.000Z')];
    expect(consecutiveMissed(rows, NOW, th)).toBe(1);
  });
});
