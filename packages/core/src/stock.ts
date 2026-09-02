import type { DoseUnit, LocalDate, MedicationStock, ScheduleRule, StockForecast, UUID } from '@dawaee/shared';
import { dosesPerDay } from './schedule.js';
import { addDays, localDateInZone } from './time.js';

/**
 * Stock tracking and run-out forecasting.
 *
 * Everything here is arithmetic on user-entered quantities. The system never
 * infers how much medication a patient "should" have, and never adjusts a
 * dose to make the numbers work.
 */

export interface ConsumptionSource {
  rule: ScheduleRule;
  doseQuantity: number;
  doseUnit: DoseUnit;
  active: boolean;
}

/** Units consumed per day across every active schedule for one medication. */
export function dailyConsumption(sources: readonly ConsumptionSource[]): number {
  return sources
    .filter((s) => s.active)
    .reduce((sum, s) => sum + dosesPerDay(s.rule) * s.doseQuantity, 0);
}

export interface ForecastInput {
  medicationId: UUID;
  stock: Pick<MedicationStock, 'remainingQuantity' | 'trackingEnabled' | 'lowStockThresholdDays'>;
  sources: readonly ConsumptionSource[];
  /** Falls back from medication override → user preference → 7. */
  defaultThresholdDays: number;
  now: Date;
  timezone: string;
}

export function forecastStock(input: ForecastInput): StockForecast | null {
  const { stock, sources, now, timezone } = input;
  if (!stock.trackingEnabled || stock.remainingQuantity === null) return null;

  const perDay = dailyConsumption(sources);
  const remaining = Math.max(0, stock.remainingQuantity);
  const thresholdDays = stock.lowStockThresholdDays ?? input.defaultThresholdDays;

  if (perDay <= 0) {
    return {
      medicationId: input.medicationId,
      remainingQuantity: remaining,
      dailyConsumption: 0,
      daysRemaining: null,
      runoutDate: null,
      isLow: false,
      thresholdDays,
    };
  }

  // Floor, not round: telling someone they have 3 days left when they have
  // 3.9 is safe; telling them 4 when they have 3.1 is not.
  const daysRemaining = Math.floor(remaining / perDay);
  const today = localDateInZone(now, timezone) as LocalDate;

  return {
    medicationId: input.medicationId,
    remainingQuantity: remaining,
    dailyConsumption: Number(perDay.toFixed(4)),
    daysRemaining,
    runoutDate: addDays(today, daysRemaining),
    isLow: daysRemaining <= thresholdDays,
    thresholdDays,
  };
}

export interface ApplyDoseResult {
  delta: number;
  balanceAfter: number;
  /** True when the decrement was clamped because the patient had less on hand. */
  clamped: boolean;
}

/**
 * Decrement stock for a confirmed dose. Never goes below zero — a negative
 * balance would be a lie about the physical world; we clamp and surface it.
 */
export function applyDoseToStock(
  remaining: number | null,
  doseQuantity: number,
  trackingEnabled: boolean,
): ApplyDoseResult | null {
  if (!trackingEnabled || remaining === null) return null;
  const delta = -Math.min(doseQuantity, remaining);
  return {
    delta,
    balanceAfter: Number((remaining + delta).toFixed(4)),
    clamped: doseQuantity > remaining,
  };
}

/** Reverse a decrement when a confirmation is undone. */
export function reverseDoseFromStock(
  remaining: number | null,
  appliedDelta: number,
  trackingEnabled: boolean,
): ApplyDoseResult | null {
  if (!trackingEnabled || remaining === null) return null;
  const delta = -appliedDelta;
  return { delta, balanceAfter: Number((remaining + delta).toFixed(4)), clamped: false };
}

export function applyRefill(remaining: number | null, quantityAdded: number): number {
  return Number(((remaining ?? 0) + quantityAdded).toFixed(4));
}

/**
 * Days of supply a given quantity buys at the current rate — used by the
 * refill screen to answer "how many should I buy?".
 */
export function daysOfSupply(quantity: number, sources: readonly ConsumptionSource[]): number | null {
  const perDay = dailyConsumption(sources);
  if (perDay <= 0) return null;
  return Math.floor(quantity / perDay);
}
