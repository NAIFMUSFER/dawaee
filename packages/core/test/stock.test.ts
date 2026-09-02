import { describe, expect, it } from 'vitest';
import {
  applyDoseToStock, applyRefill, dailyConsumption, daysOfSupply, forecastStock, reverseDoseFromStock,
  type ConsumptionSource,
} from '../src/stock.js';

const twiceDaily: ConsumptionSource = {
  rule: { kind: 'fixed_times', times: ['08:00', '20:00'] },
  doseQuantity: 1,
  doseUnit: 'tablet',
  active: true,
};

const stock = (remaining: number | null, extra: Partial<{ trackingEnabled: boolean; lowStockThresholdDays: number | null }> = {}) => ({
  remainingQuantity: remaining,
  trackingEnabled: extra.trackingEnabled ?? true,
  lowStockThresholdDays: extra.lowStockThresholdDays ?? null,
});

const NOW = new Date('2026-09-02T09:00:00Z');

describe('brief §21 / §67 — the 30-tablet scenario', () => {
  it('30 tablets, 1 tablet twice a day = 15 days of supply', () => {
    const f = forecastStock({
      medicationId: 'med-1',
      stock: stock(30),
      sources: [twiceDaily],
      defaultThresholdDays: 7,
      now: NOW,
      timezone: 'Asia/Riyadh',
    })!;
    expect(f.dailyConsumption).toBe(2);
    expect(f.daysRemaining).toBe(15);
    expect(f.isLow).toBe(false);
  });

  it('after 10 confirmed doses, 20 tablets remain and the forecast updates to 10 days', () => {
    let remaining = 30;
    for (let i = 0; i < 10; i++) {
      const r = applyDoseToStock(remaining, 1, true)!;
      remaining = r.balanceAfter;
    }
    expect(remaining).toBe(20);

    const f = forecastStock({
      medicationId: 'med-1',
      stock: stock(remaining),
      sources: [twiceDaily],
      defaultThresholdDays: 7,
      now: NOW,
      timezone: 'Asia/Riyadh',
    })!;
    expect(f.daysRemaining).toBe(10);
    expect(f.runoutDate).toBe('2026-09-12');
    expect(f.isLow).toBe(false);
  });

  it('matches the brief’s "remaining 18, runs out in 9 days" example', () => {
    const f = forecastStock({
      medicationId: 'med-1',
      stock: stock(18),
      sources: [twiceDaily],
      defaultThresholdDays: 7,
      now: NOW,
      timezone: 'Asia/Riyadh',
    })!;
    expect(f.daysRemaining).toBe(9);
  });

  it('flags low stock at the brief’s "6 tablets ≈ 3 days" example', () => {
    const f = forecastStock({
      medicationId: 'med-1',
      stock: stock(6),
      sources: [twiceDaily],
      defaultThresholdDays: 7,
      now: NOW,
      timezone: 'Asia/Riyadh',
    })!;
    expect(f.daysRemaining).toBe(3);
    expect(f.isLow).toBe(true);
  });
});

describe('consumption', () => {
  it('sums several active schedules on one medication', () => {
    const morning: ConsumptionSource = { rule: { kind: 'fixed_times', times: ['08:00'] }, doseQuantity: 2, doseUnit: 'tablet', active: true };
    expect(dailyConsumption([twiceDaily, morning])).toBe(4);
  });
  it('ignores inactive schedules', () => {
    expect(dailyConsumption([{ ...twiceDaily, active: false }])).toBe(0);
  });
  it('handles fractional weekly schedules', () => {
    const weekly: ConsumptionSource = {
      rule: { kind: 'days_of_week', weekdays: [0], times: ['09:00'] },
      doseQuantity: 1, doseUnit: 'tablet', active: true,
    };
    expect(dailyConsumption([weekly])).toBeCloseTo(1 / 7);
  });
});

describe('decrement safety', () => {
  it('never lets the balance go negative and reports the clamp', () => {
    const r = applyDoseToStock(0.5, 1, true)!;
    expect(r.balanceAfter).toBe(0);
    expect(r.clamped).toBe(true);
  });
  it('is a no-op when tracking is off', () => {
    expect(applyDoseToStock(30, 1, false)).toBeNull();
    expect(applyDoseToStock(null, 1, true)).toBeNull();
  });
  it('reverses cleanly on undo', () => {
    const taken = applyDoseToStock(30, 1, true)!;
    const undone = reverseDoseFromStock(taken.balanceAfter, taken.delta, true)!;
    expect(undone.balanceAfter).toBe(30);
  });
  it('handles fractional syrup doses without float drift', () => {
    let remaining = 100;
    for (let i = 0; i < 10; i++) remaining = applyDoseToStock(remaining, 2.5, true)!.balanceAfter;
    expect(remaining).toBe(75);
  });
});

describe('refills and supply', () => {
  it('adds a refill onto the remaining balance', () => {
    expect(applyRefill(6, 30)).toBe(36);
    expect(applyRefill(null, 30)).toBe(30);
  });
  it('answers "how many days will this box last"', () => {
    expect(daysOfSupply(30, [twiceDaily])).toBe(15);
    expect(daysOfSupply(30, [{ ...twiceDaily, rule: { kind: 'as_needed' } }])).toBeNull();
  });
});

describe('as-needed and untracked medications', () => {
  it('returns no forecast when nothing is scheduled', () => {
    const f = forecastStock({
      medicationId: 'med-1',
      stock: stock(20),
      sources: [{ ...twiceDaily, rule: { kind: 'as_needed' } }],
      defaultThresholdDays: 7,
      now: NOW,
      timezone: 'Asia/Riyadh',
    })!;
    expect(f.daysRemaining).toBeNull();
    expect(f.isLow).toBe(false);
  });
  it('returns null when tracking is disabled', () => {
    expect(
      forecastStock({
        medicationId: 'med-1',
        stock: stock(20, { trackingEnabled: false }),
        sources: [twiceDaily],
        defaultThresholdDays: 7,
        now: NOW,
        timezone: 'Asia/Riyadh',
      }),
    ).toBeNull();
  });
  it('honours a per-medication threshold override', () => {
    const f = forecastStock({
      medicationId: 'med-1',
      stock: stock(20, { lowStockThresholdDays: 12 }),
      sources: [twiceDaily],
      defaultThresholdDays: 3,
      now: NOW,
      timezone: 'Asia/Riyadh',
    })!;
    expect(f.thresholdDays).toBe(12);
    expect(f.isLow).toBe(true);
  });
});
