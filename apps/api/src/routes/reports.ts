import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES } from '@dawaee/shared';
import { addDays, dailyBreakdown, forecastStock, localDateInZone, summarizeAdherence } from '@dawaee/core';
import { requireUuid } from '../lib/params.js';
import { withUserReadOnly } from '../lib/db.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { requireProfileAccess } from '../services/access-service.js';

/**
 * Reports.
 *
 * Every report is a record of what the user confirmed in the app. None of them
 * contains an interpretation, a trend judgement, or a recommendation — the
 * doctor or pharmacist reading it draws their own conclusions, which is
 * exactly the boundary the product is built on.
 */
export function registerReportRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/reports')) await authenticate(req, null as never);
  });

  async function buildReport(
    userId: string,
    profileId: string,
    from: string,
    to: string,
    audience: 'family' | 'clinician',
  ) {
    return withUserReadOnly(userId, async (tx) => {
      const access = await requireProfileAccess(tx, userId, profileId, 'view_reports');
      const now = new Date();

      const { rows } = await tx.query(
        `SELECT d.id, d.medication_id, d.status, d.scheduled_at, d.scheduled_local_date,
                d.scheduled_local_time, d.snoozed_until, d.notified_at, d.confirmed_at,
                m.name AS medication_name, m.strength_value, m.strength_unit::text AS strength_unit,
                m.form::text AS form, s.late_after_minutes, s.missed_after_minutes,
                s.rule, s.dose_quantity, s.dose_unit::text AS dose_unit
           FROM dose_occurrences d
           JOIN medications m ON m.id = d.medication_id
           JOIN medication_schedules s ON s.id = d.schedule_id
          WHERE d.patient_profile_id = $1
            AND d.scheduled_local_date BETWEEN $2 AND $3
            AND d.status <> 'cancelled'
          ORDER BY d.scheduled_at`,
        [profileId, from, to],
      );

      const thresholds = {
        lateAfterMinutes: rows[0]?.late_after_minutes ?? 15,
        missedAfterMinutes: rows[0]?.missed_after_minutes ?? 120,
      };
      const occurrences = rows.map((r) => ({
        status: r.status, scheduledAt: r.scheduled_at.toISOString(),
        snoozedUntil: r.snoozed_until?.toISOString() ?? null,
        notifiedAt: r.notified_at?.toISOString() ?? null,
        confirmedAt: r.confirmed_at?.toISOString() ?? null,
      }));

      const byMedication = new Map<string, { name: string; strength: string | null; form: string; rows: typeof occurrences }>();
      rows.forEach((r, i) => {
        const key = r.medication_id as string;
        const bucket = byMedication.get(key) ?? {
          name: r.medication_name as string,
          strength: r.strength_value ? `${Number(r.strength_value)} ${r.strength_unit}` : null,
          form: r.form as string,
          rows: [] as typeof occurrences,
        };
        bucket.rows.push(occurrences[i]!);
        byMedication.set(key, bucket);
      });

      const summary = summarizeAdherence({ occurrences, now, thresholds, from, to });

      // Stock and refill outlook only belongs in the family report; a
      // clinician report stays focused on the confirmation record.
      let stockOutlook: unknown[] = [];
      if (audience === 'family') {
        const { rows: stockRows } = await tx.query(
          `SELECT m.id, m.name, st.unit::text AS unit, st.remaining_quantity, st.tracking_enabled,
                  st.low_stock_threshold_days
             FROM medications m JOIN medication_stock st ON st.medication_id = m.id
            WHERE m.patient_profile_id = $1 AND m.status = 'active' AND st.tracking_enabled`,
          [profileId],
        );
        const { rows: prefs } = await tx.query<{ low_stock_threshold_days: number }>(
          'SELECT low_stock_threshold_days FROM user_preferences WHERE user_id = $1', [userId],
        );
        stockOutlook = [];
        for (const st of stockRows) {
          const { rows: scheds } = await tx.query(
            `SELECT rule, dose_quantity, dose_unit::text AS dose_unit, active
               FROM medication_schedules WHERE medication_id = $1`,
            [st.id],
          );
          const forecast = forecastStock({
            medicationId: st.id,
            stock: {
              remainingQuantity: st.remaining_quantity === null ? null : Number(st.remaining_quantity),
              trackingEnabled: st.tracking_enabled,
              lowStockThresholdDays: st.low_stock_threshold_days,
            },
            sources: scheds.map((s) => ({
              rule: s.rule, doseQuantity: Number(s.dose_quantity), doseUnit: s.dose_unit, active: s.active,
            })),
            defaultThresholdDays: prefs[0]?.low_stock_threshold_days ?? 7,
            now, timezone: access.profileTimezone,
          });
          (stockOutlook as unknown[]).push({
            medicationName: st.name, unit: st.unit,
            remaining: forecast?.remainingQuantity ?? null,
            daysRemaining: forecast?.daysRemaining ?? null,
            runoutDate: forecast?.runoutDate ?? null,
            needsRefill: forecast?.isLow ?? false,
          });
        }
      }

      return {
        meta: {
          patientName: access.profileDisplayName,
          timezone: access.profileTimezone,
          from, to,
          generatedAt: now.toISOString(),
          audience,
        },
        summary,
        daily: dailyBreakdown(occurrences, now, thresholds, access.profileTimezone),
        medications: [...byMedication.values()].map((bucket) => ({
          name: bucket.name,
          strength: bucket.strength,
          form: bucket.form,
          summary: summarizeAdherence({ occurrences: bucket.rows, now, thresholds, from, to }),
        })),
        ...(audience === 'family' ? { stockOutlook } : {}),
        ...(audience === 'clinician'
          ? {
              doses: rows.map((r) => ({
                medicationName: r.medication_name,
                scheduledDate: r.scheduled_local_date,
                scheduledTime: r.scheduled_local_time,
                dose: `${Number(r.dose_quantity)} ${r.dose_unit}`,
                status: r.status,
                confirmedAt: r.confirmed_at,
              })),
            }
          : {}),
        // Both disclaimers travel with the payload so no renderer can drop them.
        disclaimers: {
          adherenceKey: 'adherence.disclaimer',
          reportKey: 'reports.disclaimer',
        },
      };
    });
  }

  app.get('/v1/reports/weekly', async (req) => {
    const { endDate } = req.query as { endDate?: string };
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const { userId } = currentUser(req);
    const to = endDate ?? localDateInZone(new Date(), 'Asia/Riyadh');
    return buildReport(userId, profileId, addDays(to, -6), to, 'family');
  });

  app.get('/v1/reports/adherence', async (req) => {
    const { profileId, from, to } = req.query as { profileId?: string; from?: string; to?: string };
    if (!profileId || !from || !to) {
      throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'profileId, from and to are required');
    }
    const { userId } = currentUser(req);
    return buildReport(userId, profileId, from, to, 'family');
  });

  /**
   * Doctor / pharmacist report. Deliberately factual: schedule, confirmation
   * history, missed doses. No conclusions, no flags, no advice.
   */
  app.get('/v1/reports/clinician', async (req) => {
    const { profileId, from, to } = req.query as { profileId?: string; from?: string; to?: string };
    if (!profileId || !from || !to) {
      throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'profileId, from and to are required');
    }
    const { userId } = currentUser(req);
    return buildReport(userId, profileId, from, to, 'clinician');
  });

  /** Full data export for the privacy screen (PDPL data-access right). */
  app.get('/v1/reports/export', async (req) => {
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const { userId } = currentUser(req);

    return withUserReadOnly(userId, async (tx) => {
      const access = await requireProfileAccess(tx, userId, profileId, 'view_reports');
      if (access.role !== 'owner') throw AppError.forbidden('Only the patient can export their data');

      const tables: Record<string, unknown[]> = {};
      const queries: Array<[string, string]> = [
        ['profile', 'SELECT * FROM patient_profiles WHERE id = $1'],
        ['medications', 'SELECT * FROM medications WHERE patient_profile_id = $1'],
        ['schedules', 'SELECT * FROM medication_schedules WHERE patient_profile_id = $1'],
        ['doses', 'SELECT * FROM dose_occurrences WHERE patient_profile_id = $1'],
        ['doseEvents', 'SELECT * FROM dose_events WHERE patient_profile_id = $1'],
        ['stock', 'SELECT * FROM medication_stock WHERE patient_profile_id = $1'],
        ['stockTransactions', 'SELECT * FROM stock_transactions WHERE patient_profile_id = $1'],
        ['refills', 'SELECT * FROM refill_events WHERE patient_profile_id = $1'],
        ['caregivers', `SELECT id, invited_name, role, status, permissions, escalation_priority, accepted_at
                          FROM caregiver_relationships WHERE patient_profile_id = $1`],
        ['notes', 'SELECT * FROM symptom_notes WHERE patient_profile_id = $1'],
        ['measurements', 'SELECT * FROM health_measurements WHERE patient_profile_id = $1'],
        ['emergencyCard', `SELECT id, blood_type, allergies, conditions_note, emergency_contacts,
                                  include_medications, include_allergies, include_contacts, qr_enabled
                             FROM emergency_cards WHERE patient_profile_id = $1`],
        ['auditLog', 'SELECT * FROM audit_logs WHERE patient_profile_id = $1 ORDER BY at DESC LIMIT 5000'],
      ];
      for (const [name, sql] of queries) {
        const { rows } = await tx.query(sql, [profileId]);
        tables[name] = rows;
      }
      return { exportedAt: new Date().toISOString(), profileId, data: tables };
    });
  });
}
