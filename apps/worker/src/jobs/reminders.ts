import type { PoolClient } from 'pg';
import {
  consecutiveMissed, DEFAULT_ESCALATION_STAGES, escalationDedupeKey, evaluateEscalation,
  localTimeInZone, type CaregiverContext, type EscalationRecipient,
} from '@dawaee/core';
import { caregiverMissedText, reminderText, t, type EscalationStage, type Locale, type NotificationChannel } from '@dawaee/shared';
import type { WorkerContext } from '../context.js';

/**
 * The reminder and escalation tick.
 *
 * For every dose that is open and past its time, this evaluates the patient's
 * escalation policy and ENQUEUES notifications. It does not send them — that
 * is the dispatcher's job — so a provider outage cannot stall the escalation
 * clock, and a crash mid-tick loses nothing.
 */

interface OpenDoseRow {
  id: string;
  patient_profile_id: string;
  medication_id: string;
  scheduled_at: Date;
  status: string;
  snoozed_until: Date | null;
  notified_at: Date | null;
  escalation_stage: number;
  escalation_completed_at: Date | null;
  dose_quantity: string;
  dose_unit: string;
  late_after_minutes: number;
  missed_after_minutes: number;
  medication_name: string;
  show_medication: boolean;
  food_instruction: string;
  profile_timezone: string;
  profile_name: string;
  patient_user_id: string | null;
  patient_phone: string | null;
  patient_locale: string;
}

export async function reminderJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  const now = ctx.now();

  const { rows } = await client.query<OpenDoseRow>(
    `SELECT d.id, d.patient_profile_id, d.medication_id, d.scheduled_at, d.status::text AS status,
            d.snoozed_until, d.notified_at, d.escalation_stage, d.escalation_completed_at,
            d.dose_quantity, d.dose_unit::text AS dose_unit,
            s.late_after_minutes, s.missed_after_minutes,
            m.name AS medication_name, m.food_instruction::text AS food_instruction,
            pp.timezone AS profile_timezone, pp.display_name AS profile_name,
            COALESCE(pp.linked_user_id, pp.owner_user_id) AS patient_user_id,
            u.phone_e164 AS patient_phone, COALESCE(u.locale,'ar') AS patient_locale,
            -- The patient's own disclosure choice governs the push body too.
            -- COALESCE to false so a row predating the column, or a patient
            -- with no preferences row at all, gets the private text — the
            -- default has to be private on every path, not only the happy one.
            COALESCE(up.show_medication_in_notifications, false) AS show_medication
       FROM dose_occurrences d
       JOIN medication_schedules s ON s.id = d.schedule_id
       JOIN medications m ON m.id = d.medication_id
       JOIN patient_profiles pp ON pp.id = d.patient_profile_id
       LEFT JOIN users u ON u.id = COALESCE(pp.linked_user_id, pp.owner_user_id)
       LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE d.status IN ('upcoming','due','pending_confirmation','snoozed')
        AND d.scheduled_at <= $1
        -- Nothing older than a day: a dose that far past is history, and
        -- waking the family about it would be noise, not care.
        AND d.scheduled_at > $1 - interval '24 hours'
        AND m.status = 'active'
      ORDER BY d.scheduled_at
      LIMIT 1000`,
    [now],
  );

  let enqueued = 0;

  for (const dose of rows) {
    const policy = await loadPolicy(client, dose.patient_profile_id, dose.medication_id);
    const caregivers = await loadCaregivers(client, dose.patient_profile_id);
    const missedStreak = await loadMissedStreak(client, dose.patient_profile_id, now, {
      lateAfterMinutes: dose.late_after_minutes,
      missedAfterMinutes: dose.missed_after_minutes,
    });

    const decision = evaluateEscalation({
      occurrence: {
        id: dose.id,
        status: dose.status as never,
        scheduledAt: dose.scheduled_at.toISOString(),
        snoozedUntil: dose.snoozed_until?.toISOString() ?? null,
        notifiedAt: dose.notified_at?.toISOString() ?? null,
        escalationStage: dose.escalation_stage,
        escalationCompletedAt: dose.escalation_completed_at?.toISOString() ?? null,
      },
      policy,
      thresholds: {
        lateAfterMinutes: dose.late_after_minutes,
        missedAfterMinutes: dose.missed_after_minutes,
      },
      caregivers,
      patient: {
        userId: dose.patient_user_id ?? '',
        phoneE164: dose.patient_phone,
        displayName: dose.profile_name,
        timezone: dose.profile_timezone,
      },
      consecutiveMissedCount: missedStreak,
      now,
    });

    if (decision.action === 'complete') {
      await client.query('UPDATE dose_occurrences SET escalation_completed_at = now() WHERE id = $1', [dose.id]);
      continue;
    }
    if (decision.action !== 'dispatch' || decision.stageIndex === null) continue;

    for (const recipient of decision.recipients) {
      for (const channel of recipient.channels) {
        const inserted = await enqueueNotification(client, {
          dose, recipient, channel,
          stageIndex: decision.stageIndex,
          stage: decision.stage!,
          now,
        });
        if (inserted) enqueued += 1;
      }
    }

    // The stage pointer advances even when a stage produced no recipients,
    // otherwise an unreachable stage would block every later one forever.
    await client.query(
      `UPDATE dose_occurrences
          SET escalation_stage = $2,
              notified_at = COALESCE(notified_at, $3),
              status = CASE WHEN status IN ('upcoming','due') THEN 'pending_confirmation'::dose_status ELSE status END
        WHERE id = $1`,
      [dose.id, decision.stageIndex + 1, now],
    );
    await client.query(
      `INSERT INTO dose_events (dose_occurrence_id, patient_profile_id, type, metadata)
       VALUES ($1,$2,$3,$4)`,
      [
        dose.id, dose.patient_profile_id,
        decision.stage!.target === 'patient' ? 'notified' : 'escalated',
        JSON.stringify({ stage: decision.stageIndex, target: decision.stage!.target, recipients: decision.recipients.length }),
      ],
    );
  }

  return { itemsProcessed: enqueued };
}

async function loadPolicy(client: PoolClient, profileId: string, medicationId: string) {
  const { rows } = await client.query<{
    enabled: boolean; stages: EscalationStage[]; quiet_hours_start: string | null; quiet_hours_end: string | null;
  }>(
    `SELECT enabled, stages, quiet_hours_start, quiet_hours_end
       FROM escalation_policies
      WHERE patient_profile_id = $1 AND (medication_id = $2 OR medication_id IS NULL)
      ORDER BY medication_id NULLS LAST
      LIMIT 1`,
    [profileId, medicationId],
  );
  const row = rows[0];
  // No configured policy means the sane default ladder, not "no reminders".
  if (!row) {
    return { enabled: true, stages: DEFAULT_ESCALATION_STAGES, quietHoursStart: null, quietHoursEnd: null };
  }
  return {
    enabled: row.enabled,
    stages: row.stages?.length ? row.stages : DEFAULT_ESCALATION_STAGES,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
  };
}

async function loadCaregivers(client: PoolClient, profileId: string): Promise<CaregiverContext[]> {
  const { rows } = await client.query(
    `SELECT cr.id, cr.caregiver_user_id, cr.invited_phone_e164, cr.invited_name,
            cr.status::text AS status, cr.permissions, cr.escalation_priority,
            COALESCE(u.phone_e164, cr.invited_phone_e164) AS contact_phone
       FROM caregiver_relationships cr
       LEFT JOIN users u ON u.id = cr.caregiver_user_id
      WHERE cr.patient_profile_id = $1 AND cr.status = 'active'
      ORDER BY cr.escalation_priority`,
    [profileId],
  );

  const { rows: ruleRows } = await client.query(
    `SELECT relationship_id, channel::text AS channel, mode::text AS mode,
            consecutive_missed_threshold, quiet_hours_start, quiet_hours_end, enabled
       FROM caregiver_notification_rules WHERE patient_profile_id = $1`,
    [profileId],
  );

  return rows.map((r) => ({
    relationship: {
      id: r.id,
      caregiverUserId: r.caregiver_user_id,
      invitedPhoneE164: r.contact_phone,
      invitedName: r.invited_name,
      status: r.status,
      permissions: r.permissions,
      escalationPriority: r.escalation_priority,
    },
    rules: ruleRows
      .filter((x) => x.relationship_id === r.id)
      .map((x) => ({
        channel: x.channel as NotificationChannel,
        mode: x.mode,
        consecutiveMissedThreshold: x.consecutive_missed_threshold,
        quietHoursStart: x.quiet_hours_start,
        quietHoursEnd: x.quiet_hours_end,
        enabled: x.enabled,
      })),
  }));
}

async function loadMissedStreak(
  client: PoolClient,
  profileId: string,
  now: Date,
  thresholds: { lateAfterMinutes: number; missedAfterMinutes: number },
): Promise<number> {
  const { rows } = await client.query(
    `SELECT status::text AS status, scheduled_at, snoozed_until, notified_at
       FROM dose_occurrences
      WHERE patient_profile_id = $1 AND scheduled_at < $2 AND status <> 'cancelled'
      ORDER BY scheduled_at DESC LIMIT 40`,
    [profileId, now],
  );
  return consecutiveMissed(
    rows.map((r) => ({
      status: r.status,
      scheduledAt: r.scheduled_at.toISOString(),
      snoozedUntil: r.snoozed_until?.toISOString() ?? null,
      notifiedAt: r.notified_at?.toISOString() ?? null,
    })),
    now,
    thresholds,
  );
}

async function enqueueNotification(
  client: PoolClient,
  input: {
    dose: OpenDoseRow;
    recipient: EscalationRecipient;
    channel: NotificationChannel;
    stageIndex: number;
    stage: EscalationStage;
    now: Date;
  },
): Promise<boolean> {
  const { dose, recipient, channel, stageIndex } = input;
  const dedupeKey = escalationDedupeKey(dose.id, stageIndex, recipient, channel);
  const locale = (dose.patient_locale === 'en' ? 'en' : 'ar') as Locale;

  const doseText = `${Number(dose.dose_quantity)} ${dose.dose_unit}`;
  const scheduledLocal = localTimeInZone(dose.scheduled_at, dose.profile_timezone);
  const foodKey = `food.${dose.food_instruction}` as never;
  const food = t(locale, foodKey);

  const isPatient = recipient.kind === 'patient';
  /**
   * The patient's disclosure choice, applied server-side.
   *
   * The same flag the phone uses, read from the same column, and applied to
   * the caregiver copy as well — it is the patient's medication being named,
   * so it is the patient's decision, and the caregiver's lock screen is
   * outside this app's control either way.
   *
   * When false, the medication name never enters `body`, never reaches the
   * push provider, and is never written to notification_deliveries below.
   */
  const showMedication = dose.show_medication === true;
  const title = isPatient ? t(locale, 'reminder.title') : t(locale, 'caregiver.alertTitle');
  const body = isPatient
    ? stageIndex === 0
      ? reminderText({
          locale, showMedication, medicationName: dose.medication_name,
          doseText, time: scheduledLocal, food,
        }).body
      : showMedication
        ? t(locale, 'reminder.repeat', { medication: dose.medication_name, time: scheduledLocal })
        : t(locale, 'reminder.repeatPrivate', { time: scheduledLocal })
    // Caregiver copy carries the minimum needed to act: who, when, unconfirmed
    // — and the medication only if the patient allows it.
    : caregiverMissedText({
        locale, showMedication, patientName: dose.profile_name,
        medicationName: dose.medication_name, time: scheduledLocal,
      }).body;

  const { rowCount } = await client.query(
    `INSERT INTO notification_deliveries
       (patient_profile_id, recipient_user_id, recipient_phone_e164, relationship_id, kind, channel,
        dose_occurrence_id, medication_id, escalation_stage, locale, title, body, payload,
        dedupe_key, scheduled_for, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5::notification_kind,$6::notification_channel,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      dose.patient_profile_id,
      recipient.userId || null,
      recipient.phoneE164,
      recipient.relationshipId,
      isPatient ? (stageIndex === 0 ? 'dose_reminder' : 'dose_reminder_repeat') : 'escalation',
      channel,
      dose.id,
      dose.medication_id,
      stageIndex,
      locale,
      title,
      body,
      JSON.stringify({
        doseId: dose.id,
        medicationId: dose.medication_id,
        scheduledAt: dose.scheduled_at.toISOString(),
        // Action buttons the notification renders on the lock screen.
        actions: isPatient ? ['taken', 'snooze', 'skip'] : [],
        patientName: dose.profile_name,
        // Withheld from the stored payload as well when disclosure is off.
        // notification_deliveries rows are read back by the dispatcher and by
        // anyone with database access; leaving the name here would keep the
        // PHI in the system while the visible text pretended otherwise.
        ...(showMedication ? { medicationName: dose.medication_name } : {}),
        scheduledLocalTime: scheduledLocal,
      }),
      dedupeKey,
      input.now,
    ],
  );
  return (rowCount ?? 0) > 0;
}
