import type { PoolClient } from 'pg';
import { groupedReminderText, reminderText, t, type Locale } from '@dawaee/shared';
import { dosesPerDay, localTimeInZone } from '@dawaee/core';

interface ReminderDelivery {
  id: string;
  patient_profile_id: string | null;
  dose_occurrence_id: string | null;
  lease_token: string;
  kind: string;
  locale: string;
  body: string | null;
  payload: Record<string, unknown>;
}

/** Reread the complete group immediately before sending any patient dose action. */
export async function currentPatientReminder(
  client: PoolClient, row: ReminderDelivery, now: Date, showMedication: boolean,
): Promise<{ body: string; payload: Record<string, unknown> } | null> {
  const grouped = row.payload.grouped === true;
  const rawIds = grouped ? row.payload.doseIds : [row.dose_occurrence_id];
  const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string =>
    typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) : [];
  if (!row.patient_profile_id || !ids.length) return null;
  const snooze = row.payload.reason === 'snooze';
  const { rows } = await client.query<{
    id: string; medication_id: string; name: string; dose_quantity: string; dose_unit: string;
    scheduled_at: Date; snoozed_until: Date | null; client_event_id: string | null;
    timezone: string; food_instruction: string;
  }>(
    `SELECT d.id, d.medication_id, m.name, d.dose_quantity, d.dose_unit::text AS dose_unit,
            d.scheduled_at, d.snoozed_until, d.client_event_id, pp.timezone, m.food_instruction::text AS food_instruction
       FROM notification_deliveries nd
       JOIN dose_occurrences d ON d.id = ANY($4::uuid[]) AND d.patient_profile_id = nd.patient_profile_id
       JOIN medications m ON m.id = d.medication_id AND m.patient_profile_id = d.patient_profile_id
       JOIN medication_schedules s ON s.id = d.schedule_id AND s.medication_id = d.medication_id
       JOIN patient_profiles pp ON pp.id = d.patient_profile_id
      WHERE nd.id = $1 AND nd.lease_token = $2 AND nd.status = 'sending'
        AND nd.lease_until > $5
        AND nd.patient_profile_id = $3
        AND nd.recipient_user_id = COALESCE(pp.linked_user_id, pp.owner_user_id)
        AND pp.archived_at IS NULL
        AND m.status = 'active' AND s.active
        AND COALESCE((SELECT ep.enabled FROM escalation_policies ep
          WHERE ep.patient_profile_id = d.patient_profile_id
            AND (ep.medication_id = d.medication_id OR ep.medication_id IS NULL)
          ORDER BY ep.medication_id NULLS LAST LIMIT 1), true)
        AND d.status IN ('upcoming','due','pending_confirmation','snoozed')
        AND ($6::boolean OR d.scheduled_at <= $5)
        AND $5 < d.scheduled_at + make_interval(mins => s.missed_after_minutes)
        AND (d.snoozed_until IS NULL OR d.snoozed_until <= $5)
      ORDER BY d.scheduled_at, d.id`,
    [row.id, row.lease_token, row.patient_profile_id, ids, now, snooze],
  );
  const versions = row.payload.intentVersions;
  const current = rows.filter((dose) => {
    const expectedVersion = versions && typeof versions === 'object'
      ? (versions as Record<string, unknown>)[dose.id] ?? null : null;
    if (snooze) return typeof row.payload.intentId === 'string'
      && dose.client_event_id === row.payload.intentId && dose.snoozed_until !== null
      && dose.snoozed_until.toISOString() === row.payload.expectedSnoozedUntil;
    return expectedVersion === (dose.snoozed_until ? dose.client_event_id : null);
  });
  if (!current.length) return null;

  const locale: Locale = row.locale === 'en' ? 'en' : 'ar';
  const first = current[0]!;
  const time = localTimeInZone(snooze ? first.snoozed_until! : first.scheduled_at, first.timezone);
  const medications = current.map((dose) => ({ name: dose.name, doseText: `${Number(dose.dose_quantity)} ${dose.dose_unit}` }));
  // Keep a group navigation action even if one member remains; never turn a
  // previously grouped alert into an unreviewed single-dose confirmation.
  const body = grouped ? groupedReminderText({ locale, showMedication, time, medications }).body
    : snooze || row.kind === 'dose_reminder'
      ? reminderText({ locale, showMedication, medicationName: first.name, doseText: medications[0]!.doseText,
        time, food: t(locale, `food.${first.food_instruction}` as never) }).body
      : t(locale, showMedication ? 'reminder.repeat' : 'reminder.repeatPrivate', { medication: first.name, time });
  const payload: Record<string, unknown> = {
    ...row.payload, scheduledLocalTime: time,
    ...(grouped ? { doseIds: current.map((dose) => dose.id), medicationIds: current.map((dose) => dose.medication_id), actions: [] }
      : { doseId: first.id, medicationId: first.medication_id }),
  };
  delete payload.medicationName;
  delete payload.medications;
  if (showMedication) {
    if (grouped) payload.medications = medications;
    else payload.medicationName = first.name;
  }
  return { body, payload };
}

/** A refill during quiet hours must not receive yesterday's low-stock text. */
export async function currentStockReminder(
  client: PoolClient, row: ReminderDelivery, now: Date, showMedication: boolean,
): Promise<{ body: string; payload: Record<string, unknown> } | null> {
  const { rows } = await client.query(
    `SELECT m.id, m.name, st.remaining_quantity, st.unit::text AS unit,
            COALESCE(st.low_stock_threshold_days, up.low_stock_threshold_days, 7) AS threshold
       FROM notification_deliveries nd
       JOIN medications m ON m.id = nd.medication_id AND m.patient_profile_id = nd.patient_profile_id
       JOIN medication_stock st ON st.medication_id = m.id
       JOIN patient_profiles pp ON pp.id = m.patient_profile_id
       LEFT JOIN user_preferences up ON up.user_id = nd.recipient_user_id
      WHERE nd.id = $1 AND nd.lease_token = $2 AND nd.status = 'sending' AND nd.lease_until > $3
        AND nd.recipient_user_id = COALESCE(pp.linked_user_id, pp.owner_user_id)
        AND pp.archived_at IS NULL AND m.status = 'active'
        AND st.tracking_enabled AND st.remaining_quantity IS NOT NULL`, [row.id, row.lease_token, now],
  );
  const stock = rows[0];
  if (!stock) return null;
  const { rows: schedules } = await client.query(
    'SELECT rule, dose_quantity FROM medication_schedules WHERE medication_id = $1 AND active', [stock.id],
  );
  const perDay = schedules.reduce((sum, schedule) => sum + dosesPerDay(schedule.rule) * Number(schedule.dose_quantity), 0);
  if (perDay <= 0) return null;
  const remaining = Number(stock.remaining_quantity), daysRemaining = Math.floor(remaining / perDay);
  if (daysRemaining > Number(stock.threshold)) return null;
  const locale: Locale = row.locale === 'en' ? 'en' : 'ar';
  const body = showMedication ? t(locale, 'stock.lowBody', {
    medication: stock.name, qty: remaining, unit: stock.unit, days: daysRemaining,
  }) : `${t(locale, 'stock.remaining', { qty: remaining, unit: stock.unit })}. ${t(locale, 'stock.runsOutIn', { days: daysRemaining })}.`;
  const payload: Record<string, unknown> = { ...row.payload, medicationId: stock.id, remaining, daysRemaining, unit: stock.unit };
  delete payload.medicationName;
  if (showMedication) payload.medicationName = stock.name;
  return { body, payload };
}
