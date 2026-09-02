import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, checkDuplicateSchema, createMedicationSchema, createScheduleSchema,
  updateMedicationSchema, updateScheduleSchema,
} from '@dawaee/shared';
import { detectHighRiskChanges, findDuplicates, forecastStock } from '@dawaee/core';
import { withUser, withUserReadOnly } from '../lib/db.js';
import { authenticate, currentUser } from '../middleware/context.js';
import {
  profileIdForMedication, profileIdForSchedule, requireProfileAccess, requireProfileOwner,
} from '../services/access-service.js';
import { diffFields, recordAudit } from '../services/audit-service.js';
import { cancelFutureDoses, materializeSchedule, rematerializeSchedule, reviveCancelledDoses, scheduleFromRow } from '../services/materializer.js';

const MEDICATION_COLUMNS = `
  m.id, m.patient_profile_id, m.name, m.brand_name, m.generic_name, m.form::text AS form,
  m.strength_value, m.strength_unit::text AS strength_unit, m.manufacturer, m.barcode, m.image_key,
  m.instructions, m.doctor_instructions, m.food_instruction::text AS food_instruction, m.notes,
  m.status::text AS status, m.start_date, m.end_date, m.expiry_date, m.prescription_id,
  m.identity_source::text AS identity_source, m.created_at, m.updated_at, m.archived_at`;

function mapMedication(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    patientProfileId: row.patient_profile_id as string,
    name: row.name as string,
    brandName: row.brand_name, genericName: row.generic_name, form: row.form,
    strengthValue: row.strength_value === null ? null : Number(row.strength_value),
    strengthUnit: row.strength_unit, manufacturer: row.manufacturer, barcode: row.barcode,
    imageKey: row.image_key, instructions: row.instructions, doctorInstructions: row.doctor_instructions,
    foodInstruction: row.food_instruction, notes: row.notes, status: row.status,
    startDate: row.start_date, endDate: row.end_date, expiryDate: row.expiry_date,
    prescriptionId: row.prescription_id, identitySource: row.identity_source,
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at,
  };
}

async function loadSchedules(tx: PoolClient, medicationId: string) {
  const { rows } = await tx.query(
    `SELECT id, medication_id, patient_profile_id, rule, rule_kind::text AS rule_kind, dose_quantity,
            dose_unit::text AS dose_unit, timezone, start_date, end_date, missed_after_minutes,
            late_after_minutes, active, created_by
       FROM medication_schedules WHERE medication_id = $1 ORDER BY created_at`,
    [medicationId],
  );
  return rows;
}

export function registerMedicationRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/medications') || req.url.startsWith('/v1/schedules')) {
      await authenticate(req, null as never);
    }
  });

  /**
   * Duplicate check, called by the client BEFORE it posts a new medication.
   * Advisory only — it warns, it never blocks. The patient decides.
   */
  app.post('/v1/medications/check-duplicate', async (req) => {
    const body = checkDuplicateSchema.parse(req.body);
    const { userId } = currentUser(req);
    return withUserReadOnly(userId, async (tx) => {
      await requireProfileAccess(tx, userId, body.patientProfileId, 'view_medications');
      const { rows } = await tx.query(
        `SELECT id, name, brand_name, generic_name, strength_value, strength_unit::text AS strength_unit,
                barcode, status::text AS status
           FROM medications WHERE patient_profile_id = $1 AND status <> 'archived'`,
        [body.patientProfileId],
      );
      const matches = findDuplicates(
        { name: body.name, strengthValue: body.strengthValue, strengthUnit: body.strengthUnit, barcode: body.barcode },
        rows.map((r) => ({
          id: r.id, name: r.name, brandName: r.brand_name, genericName: r.generic_name,
          strengthValue: r.strength_value === null ? null : Number(r.strength_value),
          strengthUnit: r.strength_unit, barcode: r.barcode, status: r.status,
        })),
      );
      return { duplicates: matches, hasDuplicates: matches.length > 0 };
    });
  });

  app.get('/v1/medications', async (req) => {
    const query = req.query as { profileId?: string; status?: string; includeStock?: string };
    if (!query.profileId) throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'profileId is required');
    const { userId } = currentUser(req);

    return withUserReadOnly(userId, async (tx) => {
      const access = await requireProfileAccess(tx, userId, query.profileId!, 'view_medications');
      const { rows } = await tx.query(
        `SELECT ${MEDICATION_COLUMNS},
                st.unit::text AS stock_unit, st.remaining_quantity, st.initial_quantity,
                st.tracking_enabled, st.low_stock_threshold_days, st.last_refill_at
           FROM medications m
           LEFT JOIN medication_stock st ON st.medication_id = m.id
          WHERE m.patient_profile_id = $1
            AND ($2::text IS NULL OR m.status = $2::medication_status)
          ORDER BY (m.status = 'active') DESC, m.name`,
        [query.profileId, query.status ?? null],
      );

      const { rows: prefs } = await tx.query<{ low_stock_threshold_days: number }>(
        'SELECT low_stock_threshold_days FROM user_preferences WHERE user_id = $1',
        [userId],
      );
      const defaultThreshold = prefs[0]?.low_stock_threshold_days ?? 7;

      const medications = [];
      for (const row of rows) {
        const schedules = await loadSchedules(tx, row.id as string);
        const stock = row.tracking_enabled === null ? null : {
          unit: row.stock_unit,
          remainingQuantity: row.remaining_quantity === null ? null : Number(row.remaining_quantity),
          initialQuantity: row.initial_quantity === null ? null : Number(row.initial_quantity),
          trackingEnabled: row.tracking_enabled,
          lowStockThresholdDays: row.low_stock_threshold_days,
          lastRefillAt: row.last_refill_at,
        };
        const forecast = stock
          ? forecastStock({
              medicationId: row.id as string,
              stock: {
                remainingQuantity: stock.remainingQuantity,
                trackingEnabled: stock.trackingEnabled as boolean,
                lowStockThresholdDays: stock.lowStockThresholdDays as number | null,
              },
              sources: schedules.map((s) => ({
                rule: s.rule, doseQuantity: Number(s.dose_quantity), doseUnit: s.dose_unit, active: s.active,
              })),
              defaultThresholdDays: defaultThreshold,
              now: new Date(),
              timezone: access.profileTimezone,
            })
          : null;

        medications.push({
          ...mapMedication(row),
          schedules: schedules.map((s) => ({
            id: s.id, rule: s.rule, ruleKind: s.rule_kind, doseQuantity: Number(s.dose_quantity),
            doseUnit: s.dose_unit, timezone: s.timezone, startDate: s.start_date, endDate: s.end_date,
            missedAfterMinutes: s.missed_after_minutes, lateAfterMinutes: s.late_after_minutes, active: s.active,
          })),
          stock,
          stockForecast: forecast,
        });
      }
      return { medications, count: medications.length };
    });
  });

  app.get('/v1/medications/:medicationId', async (req) => {
    const { medicationId } = req.params as { medicationId: string };
    const { userId } = currentUser(req);
    return withUserReadOnly(userId, async (tx) => {
      const profileId = await profileIdForMedication(tx, medicationId);
      await requireProfileAccess(tx, userId, profileId, 'view_medications');
      const { rows } = await tx.query(
        `SELECT ${MEDICATION_COLUMNS} FROM medications m WHERE m.id = $1`, [medicationId],
      );
      if (!rows[0]) throw AppError.notFound('Medication not found');
      const schedules = await loadSchedules(tx, medicationId);
      const { rows: stockRows } = await tx.query(
        `SELECT unit::text AS unit, initial_quantity, remaining_quantity, tracking_enabled,
                low_stock_threshold_days, last_refill_at
           FROM medication_stock WHERE medication_id = $1`, [medicationId],
      );
      return {
        medication: mapMedication(rows[0]),
        schedules: schedules.map((s) => ({
          id: s.id, rule: s.rule, ruleKind: s.rule_kind, doseQuantity: Number(s.dose_quantity),
          doseUnit: s.dose_unit, timezone: s.timezone, startDate: s.start_date, endDate: s.end_date,
          missedAfterMinutes: s.missed_after_minutes, lateAfterMinutes: s.late_after_minutes, active: s.active,
        })),
        stock: stockRows[0]
          ? {
              unit: stockRows[0].unit,
              initialQuantity: stockRows[0].initial_quantity === null ? null : Number(stockRows[0].initial_quantity),
              remainingQuantity: stockRows[0].remaining_quantity === null ? null : Number(stockRows[0].remaining_quantity),
              trackingEnabled: stockRows[0].tracking_enabled,
              lowStockThresholdDays: stockRows[0].low_stock_threshold_days,
              lastRefillAt: stockRows[0].last_refill_at,
            }
          : null,
      };
    });
  });

  /**
   * Create a medication, optionally with its first schedule and stock, in one
   * transaction so a half-created medication can never exist.
   */
  app.post('/v1/medications', async (req) => {
    const body = createMedicationSchema.parse(req.body);
    const { userId } = currentUser(req);
    const now = new Date();

    return withUser(userId, async (tx) => {
      const access = await requireProfileAccess(tx, userId, body.patientProfileId, 'add_medication');

      if (!body.acknowledgeDuplicate) {
        const { rows: existing } = await tx.query(
          `SELECT id, name, brand_name, generic_name, strength_value, strength_unit::text AS strength_unit,
                  barcode, status::text AS status
             FROM medications WHERE patient_profile_id = $1 AND status <> 'archived'`,
          [body.patientProfileId],
        );
        const duplicates = findDuplicates(
          { name: body.name, strengthValue: body.strengthValue, strengthUnit: body.strengthUnit, barcode: body.barcode },
          existing.map((r) => ({
            id: r.id, name: r.name, brandName: r.brand_name, genericName: r.generic_name,
            strengthValue: r.strength_value === null ? null : Number(r.strength_value),
            strengthUnit: r.strength_unit, barcode: r.barcode, status: r.status,
          })),
        );
        if (duplicates.length) {
          // 409 with the candidates attached: the client shows
          // "View existing / Add anyway" and retries with acknowledgeDuplicate.
          throw AppError.conflict(
            ERROR_CODES.DUPLICATE_MEDICATION,
            'This medication may already exist in the medication list',
            { duplicates },
          );
        }
      }

      const { rows } = await tx.query(
        `INSERT INTO medications
           (patient_profile_id, name, brand_name, generic_name, form, strength_value, strength_unit,
            manufacturer, barcode, image_key, instructions, doctor_instructions, food_instruction,
            notes, start_date, end_date, expiry_date, prescription_id, identity_source, created_by)
         VALUES ($1,$2,$3,$4,$5::medication_form,$6,$7::strength_unit,$8,$9,$10,$11,$12,
                 $13::food_instruction,$14,$15,$16,$17,$18,$19::identity_source,$20)
         RETURNING ${MEDICATION_COLUMNS.replace(/m\./g, '')}`,
        [
          body.patientProfileId, body.name, body.brandName ?? null, body.genericName ?? null, body.form,
          body.strengthValue ?? null, body.strengthUnit ?? null, body.manufacturer ?? null,
          body.barcode ?? null, body.imageKey ?? null, body.instructions ?? null,
          body.doctorInstructions ?? null, body.foodInstruction, body.notes ?? null,
          body.startDate, body.endDate ?? null, body.expiryDate ?? null, body.prescriptionId ?? null,
          body.identitySource, userId,
        ],
      );
      const medication = mapMedication(rows[0]!);

      if (body.stock) {
        await tx.query(
          `INSERT INTO medication_stock
             (medication_id, patient_profile_id, unit, initial_quantity, remaining_quantity,
              low_stock_threshold_days, tracking_enabled)
           VALUES ($1,$2,$3::dose_unit,$4,$4,$5,$6)`,
          [
            medication.id, body.patientProfileId, body.stock.unit, body.stock.initialQuantity,
            body.stock.lowStockThresholdDays ?? null, body.stock.trackingEnabled,
          ],
        );
        await tx.query(
          `INSERT INTO stock_transactions
             (medication_id, patient_profile_id, delta, reason, balance_after, actor_user_id)
           VALUES ($1,$2,$3,'initial',$3,$4)`,
          [medication.id, body.patientProfileId, body.stock.initialQuantity, userId],
        );
      }

      let scheduleId: string | null = null;
      let dosesCreated = 0;
      if (body.schedule) {
        const s = body.schedule;
        const { rows: schedRows } = await tx.query(
          `INSERT INTO medication_schedules
             (medication_id, patient_profile_id, rule_kind, rule, dose_quantity, dose_unit, timezone,
              start_date, end_date, missed_after_minutes, late_after_minutes, created_by)
           VALUES ($1,$2,$3::schedule_rule_kind,$4,$5,$6::dose_unit,$7,$8,$9,$10,$11,$12)
           RETURNING id, medication_id, patient_profile_id, rule, rule_kind::text AS rule_kind,
                     dose_quantity, dose_unit::text AS dose_unit, timezone, start_date, end_date,
                     missed_after_minutes, late_after_minutes, active, created_by`,
          [
            medication.id, body.patientProfileId, s.rule.kind, JSON.stringify(s.rule), s.doseQuantity,
            s.doseUnit, s.timezone ?? access.profileTimezone, s.startDate, s.endDate ?? null,
            s.missedAfterMinutes, s.lateAfterMinutes, userId,
          ],
        );
        scheduleId = schedRows[0]!.id;
        const result = await materializeSchedule(tx, scheduleFromRow(schedRows[0]!), now);
        dosesCreated = result.created;
      }

      await recordAudit(tx, {
        actorUserId: userId,
        actorRole: access.role === 'owner' ? 'patient' : 'caregiver',
        patientProfileId: body.patientProfileId,
        action: 'medication.created', entityType: 'medication', entityId: medication.id,
        requestId: req.id, ipHash: req.ipHash,
        newValue: { name: body.name, form: body.form, strengthValue: body.strengthValue, identitySource: body.identitySource },
      });

      return { medication, scheduleId, dosesCreated };
    });
  });

  /**
   * Update a medication.
   *
   * Changes that alter what the patient physically takes require
   * `confirmHighRiskChange`. This is a usability safeguard against a mis-tap,
   * NOT clinical validation — the app has no opinion on whether the new value
   * is medically appropriate and never suggests one.
   */
  app.patch('/v1/medications/:medicationId', async (req) => {
    const { medicationId } = req.params as { medicationId: string };
    const body = updateMedicationSchema.parse(req.body);
    const { userId } = currentUser(req);
    const now = new Date();

    return withUser(userId, async (tx) => {
      const profileId = await profileIdForMedication(tx, medicationId);
      const access = await requireProfileAccess(tx, userId, profileId, 'edit_medication');

      const { rows: beforeRows } = await tx.query(
        `SELECT ${MEDICATION_COLUMNS} FROM medications m WHERE m.id = $1 FOR UPDATE`, [medicationId],
      );
      if (!beforeRows[0]) throw AppError.notFound('Medication not found');
      const before = mapMedication(beforeRows[0]);

      const highRisk = detectHighRiskChanges({
        before: { name: before.name as string, strengthValue: before.strengthValue as number | null },
        after: { name: body.name, strengthValue: body.strengthValue ?? undefined },
      });
      if (highRisk.length && !body.confirmHighRiskChange) {
        throw AppError.conflict(
          ERROR_CODES.HIGH_RISK_CONFIRMATION_REQUIRED,
          'This change affects the medication identity or strength and needs explicit confirmation',
          { changes: highRisk, before: { name: before.name, strengthValue: before.strengthValue } },
        );
      }

      const { rows } = await tx.query(
        `UPDATE medications SET
           name = COALESCE($2, name), brand_name = COALESCE($3, brand_name),
           generic_name = COALESCE($4, generic_name), form = COALESCE($5::medication_form, form),
           strength_value = COALESCE($6, strength_value), strength_unit = COALESCE($7::strength_unit, strength_unit),
           manufacturer = COALESCE($8, manufacturer), barcode = COALESCE($9, barcode),
           image_key = COALESCE($10, image_key), instructions = COALESCE($11, instructions),
           doctor_instructions = COALESCE($12, doctor_instructions),
           food_instruction = COALESCE($13::food_instruction, food_instruction),
           notes = COALESCE($14, notes), start_date = COALESCE($15, start_date),
           end_date = COALESCE($16, end_date), expiry_date = COALESCE($17, expiry_date),
           status = COALESCE($18::medication_status, status),
           archived_at = CASE WHEN $18::medication_status = 'archived' THEN now() ELSE archived_at END
         WHERE id = $1
         RETURNING ${MEDICATION_COLUMNS.replace(/m\./g, '')}`,
        [
          medicationId, body.name ?? null, body.brandName ?? null, body.genericName ?? null,
          body.form ?? null, body.strengthValue ?? null, body.strengthUnit ?? null,
          body.manufacturer ?? null, body.barcode ?? null, body.imageKey ?? null,
          body.instructions ?? null, body.doctorInstructions ?? null, body.foodInstruction ?? null,
          body.notes ?? null, body.startDate ?? null, body.endDate ?? null, body.expiryDate ?? null,
          body.status ?? null,
        ],
      );
      const after = mapMedication(rows[0]!);

      // Pausing, completing or archiving must stop future reminders — but
      // never touch doses the patient has already acted on.
      let cancelled = 0;
      if (body.status && ['paused', 'completed', 'archived', 'expired'].includes(body.status)) {
        cancelled = await cancelFutureDoses(tx, medicationId, now);
      }
      let revived = 0;
      if (body.status === 'active' && before.status !== 'active') {
        // Resuming must undo the pause, not just stop cancelling: the doses
        // cancelled on pause still occupy their slots, so they are revived
        // first and only then is the horizon topped up.
        revived = await reviveCancelledDoses(tx, medicationId, now);
        const schedules = await loadSchedules(tx, medicationId);
        for (const s of schedules) {
          if (s.active) await materializeSchedule(tx, scheduleFromRow(s), now);
        }
      }

      const diff = diffFields(before as Record<string, unknown>, after as Record<string, unknown>);
      await recordAudit(tx, {
        actorUserId: userId,
        actorRole: access.role === 'owner' ? 'patient' : 'caregiver',
        patientProfileId: profileId,
        action: body.status === 'archived' ? 'medication.archived' : 'medication.updated',
        entityType: 'medication', entityId: medicationId, requestId: req.id, ipHash: req.ipHash,
        previousValue: diff?.previous ?? null, newValue: diff?.next ?? null,
      });

      return { medication: after, futureDosesCancelled: cancelled, futureDosesRevived: revived, highRiskChanges: highRisk };
    });
  });

  /**
   * Delete. Archival is strongly preferred and enforced: a medication with
   * dose history can only be archived, because deleting it would erase the
   * patient's adherence record.
   */
  app.delete('/v1/medications/:medicationId', async (req) => {
    const { medicationId } = req.params as { medicationId: string };
    const { force } = req.query as { force?: string };
    const { userId } = currentUser(req);
    const now = new Date();

    return withUser(userId, async (tx) => {
      const profileId = await profileIdForMedication(tx, medicationId);
      await requireProfileOwner(tx, userId, profileId);

      const { rows: history } = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM dose_occurrences
          WHERE medication_id = $1 AND status IN ('taken','taken_late','skipped','missed')`,
        [medicationId],
      );
      const historyCount = Number(history[0]?.count ?? 0);

      if (historyCount > 0 && force !== 'true') {
        await tx.query(
          `UPDATE medications SET status = 'archived', archived_at = now() WHERE id = $1`, [medicationId],
        );
        const cancelled = await cancelFutureDoses(tx, medicationId, now);
        await recordAudit(tx, {
          actorUserId: userId, patientProfileId: profileId, action: 'medication.archived',
          entityType: 'medication', entityId: medicationId, requestId: req.id, ipHash: req.ipHash,
          newValue: { reason: 'delete_requested_with_history', historyCount },
        });
        return { deleted: false, archived: true, historyCount, futureDosesCancelled: cancelled };
      }

      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'medication.deleted',
        entityType: 'medication', entityId: medicationId, requestId: req.id, ipHash: req.ipHash,
        previousValue: { historyCount },
      });
      await tx.query('DELETE FROM medications WHERE id = $1', [medicationId]);
      return { deleted: true, archived: false };
    });
  });

  // ------------------------------------------------------------ schedules

  app.post('/v1/medications/:medicationId/schedules', async (req) => {
    const { medicationId } = req.params as { medicationId: string };
    const body = createScheduleSchema.parse(req.body);
    const { userId } = currentUser(req);
    const now = new Date();

    return withUser(userId, async (tx) => {
      const profileId = await profileIdForMedication(tx, medicationId);
      const access = await requireProfileAccess(tx, userId, profileId, 'edit_schedule');
      const { rows } = await tx.query(
        `INSERT INTO medication_schedules
           (medication_id, patient_profile_id, rule_kind, rule, dose_quantity, dose_unit, timezone,
            start_date, end_date, missed_after_minutes, late_after_minutes, created_by)
         VALUES ($1,$2,$3::schedule_rule_kind,$4,$5,$6::dose_unit,$7,$8,$9,$10,$11,$12)
         RETURNING id, medication_id, patient_profile_id, rule, rule_kind::text AS rule_kind, dose_quantity,
                   dose_unit::text AS dose_unit, timezone, start_date, end_date, missed_after_minutes,
                   late_after_minutes, active, created_by`,
        [
          medicationId, profileId, body.rule.kind, JSON.stringify(body.rule), body.doseQuantity,
          body.doseUnit, body.timezone ?? access.profileTimezone, body.startDate, body.endDate ?? null,
          body.missedAfterMinutes, body.lateAfterMinutes, userId,
        ],
      );
      const created = await materializeSchedule(tx, scheduleFromRow(rows[0]!), now);
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'schedule.created',
        entityType: 'medication_schedule', entityId: rows[0]!.id, requestId: req.id, ipHash: req.ipHash,
        newValue: { rule: body.rule, doseQuantity: body.doseQuantity, doseUnit: body.doseUnit },
      });
      return { schedule: { id: rows[0]!.id, ...body }, dosesCreated: created.created };
    });
  });

  app.patch('/v1/schedules/:scheduleId', async (req) => {
    const { scheduleId } = req.params as { scheduleId: string };
    const body = updateScheduleSchema.parse(req.body);
    const { userId } = currentUser(req);
    const now = new Date();

    return withUser(userId, async (tx) => {
      const profileId = await profileIdForSchedule(tx, scheduleId);
      await requireProfileAccess(tx, userId, profileId, 'edit_schedule');

      const { rows: beforeRows } = await tx.query(
        `SELECT id, medication_id, patient_profile_id, rule, rule_kind::text AS rule_kind, dose_quantity,
                dose_unit::text AS dose_unit, timezone, start_date, end_date, missed_after_minutes,
                late_after_minutes, active, created_by
           FROM medication_schedules WHERE id = $1 FOR UPDATE`,
        [scheduleId],
      );
      const before = beforeRows[0];
      if (!before) throw AppError.notFound('Schedule not found');

      const highRisk = detectHighRiskChanges({
        before: { doseQuantity: Number(before.dose_quantity), doseUnit: before.dose_unit, ruleJson: JSON.stringify(before.rule) },
        after: {
          doseQuantity: body.doseQuantity, doseUnit: body.doseUnit,
          ruleJson: body.rule ? JSON.stringify(body.rule) : undefined,
        },
      });
      if (highRisk.length && !body.confirmHighRiskChange) {
        throw AppError.conflict(
          ERROR_CODES.HIGH_RISK_CONFIRMATION_REQUIRED,
          'This change alters the dose or its timing and needs explicit confirmation',
          {
            changes: highRisk,
            before: { doseQuantity: Number(before.dose_quantity), doseUnit: before.dose_unit, rule: before.rule },
            after: { doseQuantity: body.doseQuantity, doseUnit: body.doseUnit, rule: body.rule },
          },
        );
      }

      const { rows } = await tx.query(
        `UPDATE medication_schedules SET
           rule = COALESCE($2, rule),
           rule_kind = COALESCE($3::schedule_rule_kind, rule_kind),
           dose_quantity = COALESCE($4, dose_quantity),
           dose_unit = COALESCE($5::dose_unit, dose_unit),
           timezone = COALESCE($6, timezone),
           start_date = COALESCE($7, start_date),
           end_date = COALESCE($8, end_date),
           missed_after_minutes = COALESCE($9, missed_after_minutes),
           late_after_minutes = COALESCE($10, late_after_minutes),
           active = COALESCE($11, active)
         WHERE id = $1
         RETURNING id, medication_id, patient_profile_id, rule, rule_kind::text AS rule_kind, dose_quantity,
                   dose_unit::text AS dose_unit, timezone, start_date, end_date, missed_after_minutes,
                   late_after_minutes, active, created_by`,
        [
          scheduleId, body.rule ? JSON.stringify(body.rule) : null, body.rule?.kind ?? null,
          body.doseQuantity ?? null, body.doseUnit ?? null, body.timezone ?? null,
          body.startDate ?? null, body.endDate === undefined ? null : body.endDate,
          body.missedAfterMinutes ?? null, body.lateAfterMinutes ?? null,
          body.active === undefined ? null : body.active,
        ],
      );

      const result = await rematerializeSchedule(tx, scheduleFromRow(rows[0]!), now);
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'schedule.updated',
        entityType: 'medication_schedule', entityId: scheduleId, requestId: req.id, ipHash: req.ipHash,
        previousValue: { rule: before.rule, doseQuantity: Number(before.dose_quantity), doseUnit: before.dose_unit },
        newValue: { rule: rows[0]!.rule, doseQuantity: Number(rows[0]!.dose_quantity), doseUnit: rows[0]!.dose_unit },
      });

      return {
        schedule: {
          id: rows[0]!.id, rule: rows[0]!.rule, doseQuantity: Number(rows[0]!.dose_quantity),
          doseUnit: rows[0]!.dose_unit, timezone: rows[0]!.timezone, startDate: rows[0]!.start_date,
          endDate: rows[0]!.end_date, active: rows[0]!.active,
        },
        futureDosesRemoved: result.removed,
        dosesCreated: result.created,
        highRiskChanges: highRisk,
      };
    });
  });

  app.delete('/v1/schedules/:scheduleId', async (req) => {
    const { scheduleId } = req.params as { scheduleId: string };
    const { userId } = currentUser(req);
    return withUser(userId, async (tx) => {
      const profileId = await profileIdForSchedule(tx, scheduleId);
      await requireProfileAccess(tx, userId, profileId, 'edit_schedule');
      // Deactivate rather than delete: the dose history references it.
      await tx.query('UPDATE medication_schedules SET active = false WHERE id = $1', [scheduleId]);
      const { rowCount } = await tx.query(
        `UPDATE dose_occurrences SET status = 'cancelled'
          WHERE schedule_id = $1 AND scheduled_at > now()
            AND status IN ('upcoming','due','pending_confirmation','snoozed')`,
        [scheduleId],
      );
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'schedule.deleted',
        entityType: 'medication_schedule', entityId: scheduleId, requestId: req.id, ipHash: req.ipHash,
      });
      return { deactivated: true, futureDosesCancelled: rowCount ?? 0 };
    });
  });
}
