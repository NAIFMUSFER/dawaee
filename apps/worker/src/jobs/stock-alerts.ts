import type { PoolClient } from 'pg';
import { dosesPerDay, localDateInZone } from '@dawaee/core';
import { t, type Locale } from '@dawaee/shared';
import type { WorkerContext } from '../context.js';

/**
 * Low-stock, refill, expiry and prescription-renewal warnings.
 *
 * Each alert fires once per condition, not once per tick: `low_stock_notified_at`
 * suppresses repeats until a refill clears it. Nagging someone daily about the
 * same box is how people learn to ignore the app.
 */
export async function stockAlertJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  const now = ctx.now();
  let enqueued = 0;

  const { rows } = await client.query(
    `SELECT m.id AS medication_id, m.name, m.patient_profile_id, m.expiry_date,
            st.remaining_quantity, st.unit::text AS unit, st.low_stock_threshold_days,
            st.low_stock_notified_at,
            pp.timezone, pp.display_name AS profile_name,
            COALESCE(pp.linked_user_id, pp.owner_user_id) AS patient_user_id,
            COALESCE(up.low_stock_threshold_days, 7) AS default_threshold,
            COALESCE(u.locale,'ar') AS locale
       FROM medications m
       JOIN medication_stock st ON st.medication_id = m.id
       JOIN patient_profiles pp ON pp.id = m.patient_profile_id
       LEFT JOIN users u ON u.id = COALESCE(pp.linked_user_id, pp.owner_user_id)
       LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE m.status = 'active'
        AND st.tracking_enabled
        AND st.remaining_quantity IS NOT NULL
        AND (st.low_stock_notified_at IS NULL OR st.low_stock_notified_at < now() - interval '3 days')`,
  );

  for (const row of rows) {
    const { rows: schedules } = await client.query(
      `SELECT rule, dose_quantity, active FROM medication_schedules WHERE medication_id = $1 AND active`,
      [row.medication_id],
    );
    const perDay = schedules.reduce((sum, s) => sum + dosesPerDay(s.rule) * Number(s.dose_quantity), 0);
    if (perDay <= 0) continue;

    const remaining = Number(row.remaining_quantity);
    const daysRemaining = Math.floor(remaining / perDay);
    const threshold = row.low_stock_threshold_days ?? row.default_threshold;
    if (daysRemaining > threshold) continue;

    const locale = (row.locale === 'en' ? 'en' : 'ar') as Locale;
    const inserted = await client.query(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel, medication_id, locale, title, body,
          payload, dedupe_key, scheduled_for, next_attempt_at)
       VALUES ($1,$2,'low_stock','push',$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        row.patient_profile_id, row.patient_user_id, row.medication_id, locale,
        t(locale, 'stock.lowTitle'),
        t(locale, 'stock.lowBody', {
          medication: row.name, qty: remaining, unit: row.unit, days: daysRemaining,
        }),
        JSON.stringify({ medicationId: row.medication_id, medicationName: row.name, daysRemaining, remaining }),
        // One alert per medication per local day, whatever the tick rate.
        `stock:${row.medication_id}:${localDateInZone(now, row.timezone)}`,
        now,
      ],
    );
    if (inserted.rowCount) {
      enqueued += 1;
      await client.query('UPDATE medication_stock SET low_stock_notified_at = now() WHERE medication_id = $1', [
        row.medication_id,
      ]);
    }
  }

  enqueued += await enqueueExpiryWarnings(client, now);
  return { itemsProcessed: enqueued };
}

async function enqueueExpiryWarnings(client: PoolClient, now: Date): Promise<number> {
  const { rows } = await client.query(
    `SELECT m.id, m.name, m.expiry_date, m.patient_profile_id, pp.timezone,
            COALESCE(pp.linked_user_id, pp.owner_user_id) AS patient_user_id,
            COALESCE(up.expiry_warning_days, 30) AS warn_days,
            COALESCE(u.locale,'ar') AS locale
       FROM medications m
       JOIN patient_profiles pp ON pp.id = m.patient_profile_id
       LEFT JOIN users u ON u.id = COALESCE(pp.linked_user_id, pp.owner_user_id)
       LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE m.status IN ('active','paused')
        AND m.expiry_date IS NOT NULL
        AND m.expiry_date <= current_date + (COALESCE(up.expiry_warning_days, 30) || ' days')::interval
        AND m.expiry_date >= current_date`,
  );

  let count = 0;
  for (const row of rows) {
    const locale = (row.locale === 'en' ? 'en' : 'ar') as Locale;
    const inserted = await client.query(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, kind, channel, medication_id, locale, title, body,
          payload, dedupe_key, scheduled_for, next_attempt_at)
       VALUES ($1,$2,'expiry_warning','push',$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        row.patient_profile_id, row.patient_user_id, row.id, locale,
        t(locale, 'expiry.warningTitle'),
        // States the fact and stops. It never tells anyone to take or discard
        // an expired medication — that is a pharmacist's call.
        t(locale, 'expiry.warningBody', { medication: row.name, date: row.expiry_date }),
        JSON.stringify({ medicationId: row.id, expiryDate: row.expiry_date }),
        `expiry:${row.id}:${row.expiry_date}`,
        now,
      ],
    );
    if (inserted.rowCount) count += 1;
  }
  return count;
}
