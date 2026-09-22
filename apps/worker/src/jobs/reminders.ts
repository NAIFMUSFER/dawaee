import type { PoolClient } from 'pg';
import {
  consecutiveMissed, DEFAULT_ESCALATION_STAGES, escalationDedupeKey, evaluateEscalation,
  localTimeInZone, type CaregiverContext, type EscalationRecipient,
} from '@dawaee/core';
import {
  caregiverMissedText, groupedReminderText, reminderText, t,
  type EscalationStage, type Locale, type NotificationChannel,
} from '@dawaee/shared';
import type { WorkerContext } from '../context.js';

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
  client_event_id: string | null;
}

function simultaneousKey(dose: OpenDoseRow): string {
  return `${dose.patient_profile_id}|${dose.scheduled_at.toISOString()}`;
}

function patientDispatchKey(
  dose: OpenDoseRow,
  recipient: EscalationRecipient,
  channel: NotificationChannel,
): string {
  return [
    simultaneousKey(dose),
    recipient.userId ?? '',
    recipient.phoneE164 ?? '',
    recipient.relationshipId ?? '',
    channel,
  ].join('|');
}

export async function reminderJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  const now = ctx.now();
  let cursor: OpenDoseRow | undefined;
  let pending: OpenDoseRow[] = [];
  let itemsProcessed = 0;
  // A stable keyset visits later doses even when the first page remains open.
  // Carry the final simultaneous group over the page boundary before emitting
  // its single notification.
  while (true) {
    const { rows } = await client.query<OpenDoseRow>(
      `SELECT d.id, d.patient_profile_id, d.medication_id, d.scheduled_at, d.status::text AS status,
              d.snoozed_until, d.notified_at, d.escalation_stage, d.escalation_completed_at, d.client_event_id,
              d.dose_quantity, d.dose_unit::text AS dose_unit,
              s.late_after_minutes, s.missed_after_minutes,
              m.name AS medication_name, m.food_instruction::text AS food_instruction,
              pp.timezone AS profile_timezone, pp.display_name AS profile_name,
              COALESCE(pp.linked_user_id, pp.owner_user_id) AS patient_user_id,
              u.phone_e164 AS patient_phone, COALESCE(u.locale,'ar') AS patient_locale,
              COALESCE(up.show_medication_in_notifications, false) AS show_medication
         FROM dose_occurrences d
         JOIN medication_schedules s ON s.id = d.schedule_id
         JOIN medications m ON m.id = d.medication_id
         JOIN patient_profiles pp ON pp.id = d.patient_profile_id
         LEFT JOIN users u ON u.id = COALESCE(pp.linked_user_id, pp.owner_user_id)
         LEFT JOIN user_preferences up ON up.user_id = u.id
        WHERE d.status IN ('upcoming','due','pending_confirmation','snoozed')
          AND (d.scheduled_at <= $1 OR d.snoozed_until <= $1)
          AND d.scheduled_at > $1 - interval '24 hours'
          AND m.status = 'active'
          AND s.active
          AND ($2::timestamptz IS NULL OR (d.scheduled_at, d.patient_profile_id, d.id) > ($2::timestamptz, $3::uuid, $4::uuid))
        ORDER BY d.scheduled_at, d.patient_profile_id, d.id
        LIMIT 1000`,
      [now, cursor?.scheduled_at ?? null, cursor?.patient_profile_id ?? null, cursor?.id ?? null],
    );
    pending.push(...rows);
    if (rows.length < 1000) {
      itemsProcessed += await processDoses(client, pending, now);
      break;
    }
    cursor = rows[rows.length - 1]!;
    const tailKey = simultaneousKey(cursor);
    let split = pending.length;
    while (split > 0 && simultaneousKey(pending[split - 1]!) === tailKey) split--;
    itemsProcessed += await processDoses(client, pending.slice(0, split), now);
    pending = pending.slice(split);
  }
  return { itemsProcessed };
}

async function processDoses(client: PoolClient, rows: OpenDoseRow[], now: Date): Promise<number> {
  let enqueued = 0;
  const policies = new Map<string, Awaited<ReturnType<typeof loadPolicy>>>();
  const circles = new Map<string, Awaited<ReturnType<typeof loadCaregivers>>>();
  const streaks = new Map<string, number>();

  // Evaluate every dose first. Group membership must be based on doses that are
  // actually eligible for the same initial patient dispatch. Otherwise a dose
  // whose medication-specific reminder policy is disabled could leak into the
  // grouped text simply because it shares the same clock time.
  const evaluated: Array<{
    dose: OpenDoseRow;
    decision: ReturnType<typeof evaluateEscalation>;
    snoozeEnqueued: boolean;
  }> = [];

  for (const dose of rows) {
    const policyKey = `${dose.patient_profile_id}:${dose.medication_id}`;
    const policy = policies.get(policyKey) ?? await loadPolicy(client, dose.patient_profile_id, dose.medication_id);
    policies.set(policyKey, policy);
    const caregivers = circles.get(dose.patient_profile_id) ?? await loadCaregivers(client, dose.patient_profile_id);
    circles.set(dose.patient_profile_id, caregivers);
    const streakKey = `${simultaneousKey(dose)}:${dose.late_after_minutes}:${dose.missed_after_minutes}`;
    const missedStreak = streaks.get(streakKey) ?? await loadMissedStreak(
      client,
      dose.patient_profile_id,
      dose.scheduled_at,
      now,
      {
        lateAfterMinutes: dose.late_after_minutes,
        missedAfterMinutes: dose.missed_after_minutes,
      },
    );
    streaks.set(streakKey, missedStreak);

    let snoozeEnqueued = false;
    const patientStage = policy.stages.find((stage) => stage.target === 'patient');
    if (policy.enabled && patientStage && dose.client_event_id && dose.snoozed_until
      && dose.snoozed_until <= now
      && now.getTime() < dose.scheduled_at.getTime() + dose.missed_after_minutes * 60_000) {
      for (const channel of patientStage.channels.filter((c) => ['push', 'local', 'in_app'].includes(c))) {
        const inserted = await enqueueNotification(client, {
          dose, channel, stageIndex: 0, stage: patientStage, now, snoozeIntentId: dose.client_event_id,
          recipient: { kind: 'patient', userId: dose.patient_user_id ?? '', phoneE164: dose.patient_phone,
            relationshipId: null, channels: [channel], displayName: dose.profile_name },
        });
        if (inserted) { enqueued++; snoozeEnqueued = true; }
      }
    }

    evaluated.push({
      dose,
      snoozeEnqueued,
      decision: evaluateEscalation({
        deferQuietHours: true,
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
      }),
    });
  }

  const eligibleInitialGroups = new Map<string, OpenDoseRow[]>();
  for (const { dose, decision, snoozeEnqueued } of evaluated) {
    if (snoozeEnqueued) continue;
    if (decision.action !== 'dispatch' || decision.stageIndex !== 0) continue;
    for (const recipient of decision.recipients) {
      if (recipient.kind !== 'patient') continue;
      for (const channel of recipient.channels) {
        const key = patientDispatchKey(dose, recipient, channel);
        const group = eligibleInitialGroups.get(key);
        if (group) group.push(dose);
        else eligibleInitialGroups.set(key, [dose]);
      }
    }
  }

  const initialPatientGroupsDispatched = new Set<string>();
  for (const { dose, decision, snoozeEnqueued } of evaluated) {
    if (decision.action === 'complete') {
      await client.query('UPDATE dose_occurrences SET escalation_completed_at = now() WHERE id = $1', [dose.id]);
      continue;
    }
    if (decision.action !== 'dispatch' || decision.stageIndex === null) continue;
    // The explicit snooze reminder fulfills a patient stage due in this tick.
    // An outward stage waits until the next tick, retaining its original clock.
    if (snoozeEnqueued && decision.stage?.target !== 'patient') continue;

    let simultaneousDoseCount = 1;
    for (const recipient of decision.recipients) {
      if (snoozeEnqueued && recipient.kind === 'patient') continue;
      for (const channel of recipient.channels) {
        const dispatchKey = patientDispatchKey(dose, recipient, channel);
        const eligibleGroup = decision.stageIndex === 0 && recipient.kind === 'patient'
          ? (eligibleInitialGroups.get(dispatchKey) ?? [dose])
          : [dose];
        const groupedInitial = eligibleGroup.length > 1;
        simultaneousDoseCount = Math.max(simultaneousDoseCount, eligibleGroup.length);

        if (groupedInitial) {
          if (initialPatientGroupsDispatched.has(dispatchKey)) continue;
          initialPatientGroupsDispatched.add(dispatchKey);
        }

        const inserted = await enqueueNotification(client, {
          dose,
          recipient,
          channel,
          stageIndex: decision.stageIndex,
          stage: decision.stage!,
          now,
          groupDoses: groupedInitial ? eligibleGroup : undefined,
        });
        if (inserted) enqueued += 1;
      }
    }

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
        dose.id,
        dose.patient_profile_id,
        decision.stage!.target === 'patient' ? 'notified' : 'escalated',
        JSON.stringify({
          stage: decision.stageIndex,
          target: decision.stage!.target,
          recipients: decision.recipients.length,
          simultaneousDoseCount,
        }),
      ],
    );
  }

  return enqueued;
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
  if (!row) {
    return { enabled: true, stages: DEFAULT_ESCALATION_STAGES, quietHoursStart: null, quietHoursEnd: null };
  }

  const storedStages = row.stages?.length ? row.stages : DEFAULT_ESCALATION_STAGES;
  // The API contract now requires every enabled ladder to start with the
  // patient, but rows saved before that invariant existed can still be present
  // because `stages` is JSONB. Never let a legacy row bypass the patient. A
  // safe default preserves reminders and the outward escalation sequence while
  // leaving the stored row untouched for the user to correct explicitly.
  const stages = row.enabled && storedStages[0]?.target !== 'patient'
    ? DEFAULT_ESCALATION_STAGES
    : storedStages;

  return {
    enabled: row.enabled,
    stages,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
  };
}

async function loadCaregivers(client: PoolClient, profileId: string): Promise<CaregiverContext[]> {
  const { rows } = await client.query(
    `SELECT cr.id, cr.caregiver_user_id, cr.invited_phone_e164, cr.invited_name,
            cr.status::text AS status, cr.permissions, cr.escalation_priority,
            COALESCE(u.phone_e164, cr.invited_phone_e164) AS contact_phone,
            COALESCE(u.locale, 'ar') AS caregiver_locale
       FROM caregiver_relationships cr
       LEFT JOIN users u ON u.id = cr.caregiver_user_id
      WHERE cr.patient_profile_id = $1 AND cr.status = 'active'
        AND app.caregiver_identity_verified(cr.id)
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
    locale: r.caregiver_locale === 'en' ? 'en' : 'ar',
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
  currentScheduledAt: Date,
  now: Date,
  thresholds: { lateAfterMinutes: number; missedAfterMinutes: number },
): Promise<number> {
  const { rows } = await client.query(
    `SELECT d.status::text AS status, d.scheduled_at, d.snoozed_until, d.notified_at,
            s.late_after_minutes, s.missed_after_minutes
       FROM dose_occurrences d
       JOIN medication_schedules s ON s.id = d.schedule_id
      WHERE d.patient_profile_id = $1
        AND d.scheduled_at < $2
        AND d.status <> 'cancelled'
      ORDER BY d.scheduled_at DESC
      LIMIT 40`,
    [profileId, currentScheduledAt],
  );
  return consecutiveMissed(
    rows.map((r) => ({
      status: r.status,
      scheduledAt: r.scheduled_at.toISOString(),
      snoozedUntil: r.snoozed_until?.toISOString() ?? null,
      notifiedAt: r.notified_at?.toISOString() ?? null,
      thresholds: {
        lateAfterMinutes: r.late_after_minutes,
        missedAfterMinutes: r.missed_after_minutes,
      },
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
    groupDoses?: OpenDoseRow[];
    snoozeIntentId?: string;
  },
): Promise<boolean> {
  const { dose, recipient, channel, stageIndex } = input;
  const isPatient = recipient.kind === 'patient';
  const locale = ((isPatient ? dose.patient_locale : recipient.locale) === 'en' ? 'en' : 'ar') as Locale;
  const grouped = isPatient && stageIndex === 0 && (input.groupDoses?.length ?? 0) > 1;

  const dedupeKey = input.snoozeIntentId
    ? ['snooze', dose.id, input.snoozeIntentId, recipient.userId ?? '', channel].join(':')
    : grouped
    ? [
        'dose-group',
        dose.patient_profile_id,
        dose.scheduled_at.toISOString(),
        stageIndex,
        recipient.userId ?? '',
        recipient.phoneE164 ?? '',
        channel,
      ].join(':')
    : escalationDedupeKey(dose.id, stageIndex, recipient, channel);

  const doseText = `${Number(dose.dose_quantity)} ${dose.dose_unit}`;
  const scheduledLocal = localTimeInZone(input.snoozeIntentId ? dose.snoozed_until! : dose.scheduled_at, dose.profile_timezone);
  const foodKey = `food.${dose.food_instruction}` as never;
  const food = t(locale, foodKey);

  // The patient's lock-screen opt-in is necessary but not sufficient for a
  // caregiver. A caregiver may receive adherence alerts while deliberately
  // lacking view_medications; notification text must not become a side channel
  // around that permission boundary.
  let recipientCanViewMedication = isPatient;
  if (!isPatient && recipient.relationshipId) {
    const { rows: permissionRows } = await client.query<{ can_view_medication: boolean }>(
      `SELECT status = 'active' AND 'view_medications' = ANY(permissions) AS can_view_medication
         FROM caregiver_relationships
        WHERE id = $1 AND patient_profile_id = $2`,
      [recipient.relationshipId, dose.patient_profile_id],
    );
    recipientCanViewMedication = permissionRows[0]?.can_view_medication === true;
  }
  const showMedication = dose.show_medication === true && recipientCanViewMedication;
  const title = isPatient ? t(locale, 'reminder.title') : t(locale, 'caregiver.alertTitle');

  const body = grouped
    ? groupedReminderText({
        locale,
        showMedication,
        time: scheduledLocal,
        medications: input.groupDoses!.map((item) => ({
          name: item.medication_name,
          doseText: `${Number(item.dose_quantity)} ${item.dose_unit}`,
        })),
      }).body
    : isPatient
      ? stageIndex === 0
        ? reminderText({
            locale, showMedication, medicationName: dose.medication_name,
            doseText, time: scheduledLocal, food,
          }).body
        : showMedication
          ? t(locale, 'reminder.repeat', { medication: dose.medication_name, time: scheduledLocal })
          : t(locale, 'reminder.repeatPrivate', { time: scheduledLocal })
      : caregiverMissedText({
          locale, showMedication, patientName: dose.profile_name,
          medicationName: dose.medication_name, time: scheduledLocal,
        }).body;

  const payload = grouped
    ? {
        grouped: true,
        doseIds: input.groupDoses!.map((item) => item.id),
        medicationIds: input.groupDoses!.map((item) => item.medication_id),
        scheduledAt: dose.scheduled_at.toISOString(),
        scheduledLocalTime: scheduledLocal,
        actions: [],
        patientName: dose.profile_name,
        ...(showMedication ? {
          medications: input.groupDoses!.map((item) => ({
            name: item.medication_name,
            doseText: `${Number(item.dose_quantity)} ${item.dose_unit}`,
          })),
        } : {}),
      }
    : {
        doseId: dose.id,
        ...(input.snoozeIntentId ? {
          reason: 'snooze', intentId: input.snoozeIntentId,
          expectedSnoozedUntil: dose.snoozed_until!.toISOString(),
        } : {}),
        medicationId: dose.medication_id,
        scheduledAt: dose.scheduled_at.toISOString(),
        actions: isPatient ? ['taken', 'snooze', 'skip'] : [],
        patientName: dose.profile_name,
        ...(showMedication ? { medicationName: dose.medication_name } : {}),
        scheduledLocalTime: scheduledLocal,
      };

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
      isPatient ? (stageIndex === 0 && !input.snoozeIntentId ? 'dose_reminder' : 'dose_reminder_repeat') : 'escalation',
      channel,
      dose.id,
      dose.medication_id,
      stageIndex,
      locale,
      title,
      body,
      JSON.stringify({
        ...payload,
        intentVersions: Object.fromEntries((input.groupDoses ?? [dose]).map((item) =>
          [item.id, item.snoozed_until ? item.client_event_id : null])),
      }),
      dedupeKey,
      input.now,
    ],
  );
  return (rowCount ?? 0) > 0;
}
