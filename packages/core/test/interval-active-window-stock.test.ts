import { describe, expect, it } from 'vitest';
import { dosesPerDay, expandSchedule } from '../src/schedule.js';
import { forecastStock, type ConsumptionSource } from '../src/stock.js';
import { makeSchedule } from './helpers.js';

const rule = {
  kind: 'interval',
  everyHours: 8,
  anchorTime: '08:00',
  activeFrom: '08:00',
  activeUntil: '20:00',
} as const;

describe('interval active-window stock forecasting', () => {
  it('uses the same daily rate as the concrete schedule engine for an anchored repeating day', () => {
    const schedule = makeSchedule({
      rule,
      timezone: 'Asia/Riyadh',
      startDate: '2026-09-01',
    });

    // One complete Riyadh local day: 2026-09-02 00:00 -> 2026-09-03 00:00.
    // The real schedule engine emits 08:00 and 16:00. The 00:00 occurrence is
    // outside the active [08:00, 20:00) window.
    const occurrences = expandSchedule(schedule, {
      from: new Date('2026-09-01T21:00:00Z'),
      to: new Date('2026-09-02T21:00:00Z'),
    });

    expect(occurrences.map((o) => o.scheduledLocalTime)).toEqual(['08:00', '16:00']);
    expect(dosesPerDay(rule)).toBe(occurrences.length);
  });

  it('does not overstate days of stock when the active window admits two anchored doses per day', () => {
    const source: ConsumptionSource = {
      rule,
      doseQuantity: 1,
      doseUnit: 'tablet',
      active: true,
    };

    const forecast = forecastStock({
      medicationId: 'med-interval-window',
      stock: {
        remainingQuantity: 10,
        trackingEnabled: true,
        lowStockThresholdDays: null,
      },
      sources: [source],
      defaultThresholdDays: 3,
      now: new Date('2026-09-02T09:00:00Z'),
      timezone: 'Asia/Riyadh',
    });

    expect(forecast).not.toBeNull();
    expect(forecast!.dailyConsumption).toBe(2);
    expect(forecast!.daysRemaining).toBe(5);
  });
});
