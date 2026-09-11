import type { PoolClient } from 'pg';
import { localDateInZone, localTimeInZone, summarizeAdherence, addDays } from '@dawaee/core';
import { t, type Locale } from '@dawaee/shared';
import type { WorkerContext } from '../context.js';

/**
 * Daily and weekly caregiver digests.
 *
 * The quiet alternative to per-dose alerts: a caregiver who does not want to
 * hear about every reminder still gets one summary at a time they chose. This
 * is why `every_dose` is not the default anywhere in the product.
 */
export async function digestJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  const now = ctx.now();

  const { rows } = await client.query(
    `SELECT r.id AS rule_id, r.relationship_id, r.mode::text AS mode, r.channel::text AS channel,
            r.summary_time, cr.caregiver_user_id, cr.invited_phone_e164,
            COALESCE(u.phone_e164, cr.invited_phone_e164) AS contact_phone,
            cr.patient_profile_id, pp.timezone, pp.display_name AS profile_name,
            COALESCE(u.locale,'ar') AS locale
       FROM caregiver_notification_rules r
       JOIN caregiver_relationships cr ON cr.id = r.relationship_id
       LEFT JOIN users u ON u.id = cr.caregiver_user_id
       JOIN patient_profiles pp ON pp.id = cr.patient_profile_id
      WHERE r.enabled
        AND cr.status = 'active'
        AND r.mode IN ('daily_summary','weekly_summary')
        AND r.summary_time IS NOT NULL
        -- `receive_notifications` permits a delivery channel; it does not grant
        -- the adherence/schedule data that this summary calculates. Match the
        -- /v1/adherence dependency contract before the worker reads or queues it.
        AND 'receive_notifications' = ANY (cr.permissions)
        AND 'view_adherence' = ANY (cr.permissions)
        AND 'view_schedule' = ANY (cr.permissions)`,
  );

  let enqueued = 0;
  for (const row of rows) {
    const localTime = localTimeInZone(now, row.timezone);
    const localDate = localDateInZone(now, row.timezone);
    // Fire within the minute the caregiver asked for, in the PATIENT's
    // timezone — a son in London still gets his father's Riyadh-evening summary.
    if (localTime !== String(row.summary_time).slice(0, 5)) continue;
    if (row.mode === 'weekly_summary' && new Date(`${localDate}T00:00:00Z`).getUTCDay() !== 0) continue;

    const from = row.mode === 'weekly_summary' ? addDays(localDate, -7) : addDays(localDate, -1);
    const to = addDays(localDate, -1);

    const { rows: doses } = await client.query(
      `SELECT d.status::text AS status, d.scheduled_at, d.snoozed_until, d.notified_at, d.confirmed_at,
              s.late_after_minutes, s.missed_after_minutes
         FROM dose_occurrences d
         JOIN medication_schedules s ON s.id = d.schedule_id
        WHERE d.patient_profile_id = $1 AND d.scheduled_local_date BETWEEN $2 AND $3
          AND d.status <> 'cancelled'`,
      [row.patient_profile_id, from, to],
    );
    if (doses.length === 0) continue;

    const summary = summarizeAdherence({
      occurrences: doses.map((d) => ({
        status: d.status, scheduledAt: d.scheduled_at.toISOString(),
        snoozedUntil: d.snoozed_until?.toISOString() ?? null,
        notifiedAt: d.notified_at?.toISOString() ?? null,
        confirmedAt: d.confirmed_at?.toISOString() ?? null,
        thresholds: {
          lateAfterMinutes: d.late_after_minutes,
          missedAfterMinutes: d.missed_after_minutes,
        },
      })),
      now,
      thresholds: {
        lateAfterMinutes: doses[0]!.late_after_minutes,
        missedAfterMinutes: doses[0]!.missed_after_minutes,
      },
      from, to,
    });

    const locale = (row.locale === 'en' ? 'en' : 'ar') as Locale;
    const body = t(locale, 'caregiver.dailySummary', {
      patient: row.profile_name,
      scheduled: summary.scheduled,
      taken: summary.taken,
      missed: summary.missed,
      percent: summary.adherencePercent ?? 0,
    });

    const inserted = await client.query(
      `INSERT INTO notification_deliveries
         (patient_profile_id, recipient_user_id, recipient_phone_e164, relationship_id, kind, channel,
          locale, title, body, payload, dedupe_key, scheduled_for, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5::notification_kind,$6::notification_channel,$7,$8,$9,$10,$11,$12,$12)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        row.patient_profile_id, row.caregiver_user_id, row.contact_phone, row.relationship_id,
        row.mode, row.channel, locale,
        t(locale, 'reports.weeklyFamily'),
        body,
        JSON.stringify({
          patientName: row.profile_name,
          scheduled: summary.scheduled, taken: summary.taken, missed: summary.missed,
          adherencePercent: summary.adherencePercent,
          disclaimerKey: 'adherence.disclaimer',
        }),
        `digest:${row.rule_id}:${localDate}`,
        now,
      ],
    );
    if (inserted.rowCount) enqueued += 1;
  }

  return { itemsProcessed: enqueued };
}
