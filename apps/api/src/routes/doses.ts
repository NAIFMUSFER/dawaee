import type { FastifyInstance } from 'fastify';
import {
  AppError, confirmDoseSchema, skipDoseSchema, snoozeDoseSchema, syncDoseActionsSchema,
} from '@dawaee/shared';
import { can, consecutiveMissed, dailyBreakdown, localDateInZone, summarizeAdherence, viewOf } from '@dawaee/core';
import { requireDateRange, requireUuid, optionalUuid, requireLimit } from '../lib/params.js';
import { withUser, withUserReadOnly } from '../lib/db.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { profileIdForDose, requireProfileAccess } from '../services/access-service.js';
import { confirmDose, skipDoseAction, snoozeDose, undoDose } from '../services/dose-service.js';
import { CLIENT_PREFETCH_DAYS } from '../services/materializer.js';
import { now as serverNow } from '../lib/clock.js';

const DOSE_LIST_SELECT = `
  SELECT d.id, d.medication_id, d.schedule_id, d.patient_profile_id, d.scheduled_at,
         d.scheduled_local_date, d.scheduled_local_time, d.scheduled_timezone,
         d.dose_quantity, d.dose_unit::text AS dose_unit, d.status, d.notified_at, d.snoozed_until,
         d.snooze_count, d.confirmed_at, d.confirmation_method::text AS confirmation_method,
         d.escalation_stage,
         m.name AS medication_name, m.form::text AS medication_form, m.image_key,
         m.strength_value, m.strength_unit::text AS strength_unit,
         m.food_instruction::text AS food_instruction, m.instructions,
         s.late_after_minutes, s.missed_after_minutes
    FROM dose_occurrences d
    JOIN medications m ON m.id = d.medication_id
    JOIN medication_schedules s ON s.id = d.schedule_id`;

function mapDose(row: Record<string, unknown>, now: Date) {
  const thresholds = {
    lateAfterMinutes: row.late_after_minutes as number,
    missedAfterMinutes: row.missed_after_minutes as number,
  };
  const occ = {
    id: row.id as string,
    status: row.status as never,
    scheduledAt: (row.scheduled_at as Date).toISOString(),
    snoozedUntil: row.snoozed_until ? (row.snoozed_until as Date).toISOString() : null,
    notifiedAt: row.notified_at ? (row.notified_at as Date).toISOString() : null,
    confirmedAt: row.confirmed_at ? (row.confirmed_at as Date).toISOString() : null,
  };
  const view = viewOf(occ, now, thresholds);
  return {
    id: row.id,
    medicationId: row.medication_id,
    scheduleId: row.schedule_id,
    scheduledAt: occ.scheduledAt,
    scheduledLocalDate: row.scheduled_local_date,
    scheduledLocalTime: row.scheduled_local_time,
    scheduledTimezone: row.scheduled_timezone,
    doseQuantity: Number(row.dose_quantity),
    doseUnit: row.dose_unit,
    // The stored status can be stale (the phone was off); the derived one is truth.
    status: view.status,
    storedStatus: row.status,
    minutesLate: view.minutesLate,
    snoozedUntil: occ.snoozedUntil,
    snoozeCount: row.snooze_count,
    confirmedAt: occ.confirmedAt,
    confirmationMethod: row.confirmation_method,
    escalationStage: row.escalation_stage,
    medication: {
      name: row.medication_name,
      form: row.medication_form,
      imageKey: row.image_key,
      strengthValue: row.strength_value === null ? null : Number(row.strength_value),
      strengthUnit: row.strength_unit,
      foodInstruction: row.food_instruction,
      instructions: row.instructions,
    },
    thresholds,
  };
}

export function registerDoseRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/doses') || req.url.startsWith('/v1/today') || req.url.startsWith('/v1/adherence')) {
      await authenticate(req, null as never);
    }
  });

  /**
   * The Today screen in one request: the next dose, everything scheduled for
   * the patient's local day, and a short prefetch window the device caches for
   * offline local notifications.
   */
  app.get('/v1/today', async (req) => {
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const { userId } = currentUser(req);
    const now = serverNow();

    return withUserReadOnly(userId, async (tx) => {
      const access = await requireProfileAccess(tx, userId, profileId, 'view_schedule');
      const today = localDateInZone(now, access.profileTimezone);

      const { rows } = await tx.query(
        `${DOSE_LIST_SELECT}
          WHERE d.patient_profile_id = $1
            AND d.scheduled_local_date = $2
            AND d.status <> 'cancelled'
          ORDER BY d.scheduled_at`,
        [profileId, today],
      );
      const doses = rows.map((r) => mapDose(r, now));

      const { rows: upcomingRows } = await tx.query(
        `${DOSE_LIST_SELECT}
          WHERE d.patient_profile_id = $1
            AND d.scheduled_at > $2
            AND d.scheduled_at <= $3
            AND d.status IN ('upcoming','due','pending_confirmation','snoozed')
          ORDER BY d.scheduled_at
          LIMIT 400`,
        [profileId, now, new Date(now.getTime() + CLIENT_PREFETCH_DAYS * 86_400_000)],
      );
      const prefetch = upcomingRows.map((r) => mapDose(r, now));

      // "Next" is the first dose still awaiting an answer — including one that
      // is overdue but inside its window, because that is what the patient
      // most needs to see.
      const next =
        doses.find((d) => ['due', 'pending_confirmation'].includes(d.status)) ??
        doses.find((d) => d.status === 'snoozed') ??
        prefetch[0] ?? null;

      return {
        profileId,
        localDate: today,
        timezone: access.profileTimezone,
        serverTime: now.toISOString(),
        next,
        today: doses,
        prefetch,
        prefetchDays: CLIENT_PREFETCH_DAYS,
      };
    });
  });

  /** History and calendar. Bounded to 400 days so a range cannot be abused. */
  app.get('/v1/doses', async (req) => {
    const q = req.query as { profileId?: string; from?: string; to?: string; medicationId?: string; status?: string; limit?: string };
    const profileId = requireUuid(q.profileId, 'profileId');
    const range = requireDateRange(q.from, q.to);
    const medicationId = optionalUuid(q.medicationId, 'medicationId');
    const { userId } = currentUser(req);
    const now = serverNow();

    return withUserReadOnly(userId, async (tx) => {
      await requireProfileAccess(tx, userId, profileId, 'view_history');
      const { rows } = await tx.query(
        `${DOSE_LIST_SELECT}
          WHERE d.patient_profile_id = $1
            AND d.scheduled_local_date BETWEEN $2 AND $3
            AND ($4::uuid IS NULL OR d.medication_id = $4::uuid)
            AND d.status <> 'cancelled'
          ORDER BY d.scheduled_at DESC
          LIMIT $5`,
        [profileId, range.from, range.to, medicationId, requireLimit(q.limit, 500, 2000)],
      );
      let doses = rows.map((r) => mapDose(r, now));
      if (q.status) doses = doses.filter((d) => d.status === q.status);
      return { doses, count: doses.length, from: range.from, to: range.to };
    });
  });

  app.get('/v1/doses/:doseId', async (req) => {
    const { doseId } = req.params as { doseId: string };
    const { userId } = currentUser(req);
    const now = serverNow();
    return withUserReadOnly(userId, async (tx) => {
      const profileId = await profileIdForDose(tx, doseId);
      await requireProfileAccess(tx, userId, profileId, 'view_schedule');
      const { rows } = await tx.query(`${DOSE_LIST_SELECT} WHERE d.id = $1`, [doseId]);
      if (!rows[0]) throw AppError.notFound('Dose not found');
      const { rows: events } = await tx.query(
        `SELECT type::text AS type, at, method::text AS method, metadata
           FROM dose_events WHERE dose_occurrence_id = $1 ORDER BY at`,
        [doseId],
      );
      return { dose: mapDose(rows[0], now), events };
    });
  });

  app.post('/v1/doses/:doseId/taken', async (req) => {
    const { doseId } = req.params as { doseId: string };
    const body = confirmDoseSchema.parse(req.body);
    const { userId } = currentUser(req);
    const now = serverNow();

    return withUser(userId, async (tx) => {
      const profileId = await profileIdForDose(tx, doseId);
      const access = await requireProfileAccess(tx, userId, profileId, 'confirm_dose');
      return confirmDose(tx, {
        doseId, userId,
        actorRole: access.role === 'owner' ? 'patient' : 'caregiver',
        clientEventId: body.clientEventId,
        takenAt: body.takenAt,
        // A caregiver confirming on the patient's behalf is recorded as such,
        // so the history never implies the patient tapped it themselves.
        method: access.role === 'caregiver' ? 'caregiver' : body.method,
        deviceId: body.deviceId,
        voiceConfidence: body.voiceConfidence,
        note: body.note,
        now, requestId: req.id, ipHash: req.ipHash,
      });
    });
  });

  app.post('/v1/doses/:doseId/snooze', async (req) => {
    const { doseId } = req.params as { doseId: string };
    const body = snoozeDoseSchema.parse(req.body);
    const { userId } = currentUser(req);
    return withUser(userId, async (tx) => {
      const profileId = await profileIdForDose(tx, doseId);
      await requireProfileAccess(tx, userId, profileId, 'confirm_dose');
      return snoozeDose(tx, {
        doseId, userId, minutes: body.minutes, clientEventId: body.clientEventId,
        deviceId: body.deviceId, now: serverNow(), requestId: req.id, ipHash: req.ipHash,
      });
    });
  });

  app.post('/v1/doses/:doseId/skip', async (req) => {
    const { doseId } = req.params as { doseId: string };
    const body = skipDoseSchema.parse(req.body);
    const { userId } = currentUser(req);
    return withUser(userId, async (tx) => {
      const profileId = await profileIdForDose(tx, doseId);
      await requireProfileAccess(tx, userId, profileId, 'confirm_dose');
      return skipDoseAction(tx, {
        doseId, userId, reason: body.reason, clientEventId: body.clientEventId,
        deviceId: body.deviceId, now: serverNow(), requestId: req.id, ipHash: req.ipHash,
      });
    });
  });

  app.post('/v1/doses/:doseId/undo', async (req) => {
    const { doseId } = req.params as { doseId: string };
    const { userId } = currentUser(req);
    return withUser(userId, async (tx) => {
      const profileId = await profileIdForDose(tx, doseId);
      await requireProfileAccess(tx, userId, profileId, 'confirm_dose');
      return undoDose(tx, { doseId, userId, now: serverNow(), requestId: req.id, ipHash: req.ipHash });
    });
  });

  /**
   * Offline replay.
   *
   * Each action carries its own client event id, so a partially applied batch
   * can be retried whole. Failures are reported per item rather than failing
   * the batch: one stale action must not block the other nineteen.
   */
  app.post('/v1/doses/sync', async (req) => {
    const body = syncDoseActionsSchema.parse(req.body);
    const { userId } = currentUser(req);
    const now = serverNow();
    const results: Array<{ clientEventId: string; ok: boolean; status?: string; error?: string; replay?: boolean }> = [];

    for (const action of body.actions) {
      try {
        const outcome = await withUser(userId, async (tx) => {
          const profileId = await profileIdForDose(tx, action.doseOccurrenceId);
          const access = await requireProfileAccess(tx, userId, profileId, 'confirm_dose');
          if (action.type === 'taken') {
            return confirmDose(tx, {
              doseId: action.doseOccurrenceId, userId,
              actorRole: access.role === 'owner' ? 'patient' : 'caregiver',
              clientEventId: action.clientEventId, takenAt: action.at,
              method: 'app', deviceId: body.deviceId, now, requestId: req.id, ipHash: req.ipHash,
            });
          }
          if (action.type === 'skipped') {
            return skipDoseAction(tx, {
              doseId: action.doseOccurrenceId, userId, reason: action.reason,
              clientEventId: action.clientEventId, deviceId: body.deviceId, now,
              requestId: req.id, ipHash: req.ipHash,
            });
          }
          return snoozeDose(tx, {
            doseId: action.doseOccurrenceId, userId, minutes: action.minutes,
            clientEventId: action.clientEventId, deviceId: body.deviceId, now,
            requestId: req.id, ipHash: req.ipHash,
          });
        });
        results.push({
          clientEventId: action.clientEventId,
          ok: true,
          status: 'status' in outcome ? String(outcome.status) : 'snoozed',
          replay: 'idempotentReplay' in outcome ? outcome.idempotentReplay : false,
        });
      } catch (err) {
        results.push({
          clientEventId: action.clientEventId,
          ok: false,
          error: err instanceof AppError ? err.code : 'internal_error',
        });
      }
    }

    return {
      results,
      applied: results.filter((r) => r.ok && !r.replay).length,
      replayed: results.filter((r) => r.replay).length,
      failed: results.filter((r) => !r.ok).length,
      serverTime: now.toISOString(),
    };
  });

  /** Adherence analytics. Always returned with its non-diagnostic disclaimer key. */
  app.get('/v1/adherence', async (req) => {
    const q = req.query as { profileId?: string; from?: string; to?: string; medicationId?: string };
    const profileId = requireUuid(q.profileId, 'profileId');
    const range = requireDateRange(q.from, q.to);
    const medicationId = optionalUuid(q.medicationId, 'medicationId');
    const { userId } = currentUser(req);
    const now = serverNow();

    return withUserReadOnly(userId, async (tx) => {
      const access = await requireProfileAccess(tx, userId, profileId, 'view_adherence');
      // Medication names are a separate, stricter grant than the adherence
      // numbers, so the join is LEFT and the name is only surfaced below when
      // the caller may actually see the medication list.
      const canSeeMedicationNames = can(access, 'view_medications');
      const { rows } = await tx.query(
        `SELECT d.status, d.scheduled_at, d.snoozed_until, d.notified_at, d.confirmed_at,
                d.medication_id, m.name AS medication_name,
                s.late_after_minutes, s.missed_after_minutes
           FROM dose_occurrences d
           LEFT JOIN medications m ON m.id = d.medication_id
           JOIN medication_schedules s ON s.id = d.schedule_id
          WHERE d.patient_profile_id = $1
            AND d.scheduled_local_date BETWEEN $2 AND $3
            AND ($4::uuid IS NULL OR d.medication_id = $4::uuid)`,
        [profileId, range.from, range.to, medicationId],
      );

      const occurrences = rows.map((r) => ({
        status: r.status, scheduledAt: r.scheduled_at.toISOString(),
        snoozedUntil: r.snoozed_until?.toISOString() ?? null,
        notifiedAt: r.notified_at?.toISOString() ?? null,
        confirmedAt: r.confirmed_at?.toISOString() ?? null,
      }));
      const thresholds = {
        lateAfterMinutes: rows[0]?.late_after_minutes ?? 15,
        missedAfterMinutes: rows[0]?.missed_after_minutes ?? 120,
      };

      const byMedication = new Map<string, { name: string; rows: typeof occurrences }>();
      rows.forEach((r, i) => {
        const bucket = byMedication.get(r.medication_id) ?? { name: r.medication_name, rows: [] as typeof occurrences };
        bucket.rows.push(occurrences[i]!);
        byMedication.set(r.medication_id, bucket);
      });

      return {
        summary: summarizeAdherence({ occurrences, now, thresholds, from: range.from, to: range.to }),
        daily: dailyBreakdown(occurrences, now, thresholds, access.profileTimezone),
        byMedication: canSeeMedicationNames
          ? [...byMedication.entries()].map(([medicationId, bucket]) => ({
              medicationId,
              medicationName: bucket.name,
              summary: summarizeAdherence({ occurrences: bucket.rows, now, thresholds, from: range.from, to: range.to }),
            }))
          : [],
        byMedicationWithheld: !canSeeMedicationNames,
        consecutiveMissed: consecutiveMissed(occurrences, now, thresholds),
        // The client renders this string; the number never appears without it.
        disclaimerKey: 'adherence.disclaimer',
      };
    });
  });
}
