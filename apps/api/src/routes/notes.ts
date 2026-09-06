import type { FastifyInstance } from 'fastify';
import { MEASUREMENT_TYPES, createMeasurementSchema, createSymptomNoteSchema } from '@dawaee/shared';
import { optionalDate, requireEnum, requireUuid } from '../lib/params.js';
import { withUser, withUserReadOnly } from '../lib/db.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { requireProfileAccess, requireProfileOwner } from '../services/access-service.js';
import { now as serverNow } from '../lib/clock.js';

/**
 * Post-dose notes and optional health measurements.
 *
 * Both are stored exactly as entered and never interpreted. The app does not
 * infer an adverse reaction from a symptom note, does not classify a blood
 * pressure reading, and does not surface either as a clinical signal.
 */
export function registerNoteRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/notes') || req.url.startsWith('/v1/measurements')) {
      await authenticate(req, null as never);
    }
  });

  app.get('/v1/notes', async (req) => {
    const q = req.query as { profileId?: string; from?: string; to?: string };
    const profileId = requireUuid(q.profileId, 'profileId');
    const from = optionalDate(q.from, 'from');
    const to = optionalDate(q.to, 'to');
    const { userId } = currentUser(req);
    return withUserReadOnly(userId, async (tx) => {
      await requireProfileAccess(tx, userId, profileId, 'view_history');
      const { rows } = await tx.query(
        `SELECT n.id, n.tags, n.text, n.recorded_at, n.dose_occurrence_id, m.name AS medication_name
           FROM symptom_notes n
           LEFT JOIN dose_occurrences d ON d.id = n.dose_occurrence_id
           LEFT JOIN medications m ON m.id = d.medication_id
          WHERE n.patient_profile_id = $1
            AND ($2::date IS NULL OR n.recorded_at >= $2::date)
            AND ($3::date IS NULL OR n.recorded_at < ($3::date + 1))
          ORDER BY n.recorded_at DESC LIMIT 300`,
        [profileId, from, to],
      );
      return {
        notes: rows.map((r) => ({
          id: r.id, tags: r.tags, text: r.text, recordedAt: r.recorded_at,
          doseOccurrenceId: r.dose_occurrence_id, medicationName: r.medication_name,
        })),
        // Restated to every consumer of this data.
        interpretationNotice: 'Recorded as entered by the user. Not interpreted or diagnosed by the app.',
      };
    });
  });

  app.post('/v1/notes', async (req) => {
    const body = createSymptomNoteSchema.parse(req.body);
    const { userId } = currentUser(req);
    return withUser(userId, async (tx) => {
      await requireProfileAccess(tx, userId, body.profileId, 'confirm_dose');
      const { rows } = await tx.query(
        `INSERT INTO symptom_notes (patient_profile_id, dose_occurrence_id, tags, text, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, recorded_at`,
        [body.profileId, body.doseOccurrenceId ?? null, body.tags, body.text ?? null, userId],
      );
      return { note: { id: rows[0]!.id, recordedAt: rows[0]!.recorded_at } };
    });
  });

  app.get('/v1/measurements', async (req) => {
    const q = req.query as { profileId?: string; type?: string; from?: string; to?: string };
    const profileId = requireUuid(q.profileId, 'profileId');
    const type = requireEnum(q.type, MEASUREMENT_TYPES, 'type');
    const { userId } = currentUser(req);
    return withUserReadOnly(userId, async (tx) => {
      await requireProfileAccess(tx, userId, profileId, 'view_history');
      const { rows } = await tx.query(
        `SELECT id, type::text AS type, value_primary, value_secondary, unit, measured_at,
                dose_occurrence_id, note
           FROM health_measurements
          WHERE patient_profile_id = $1
            AND ($2::text IS NULL OR type = $2::measurement_type)
          ORDER BY measured_at DESC LIMIT 500`,
        [profileId, type],
      );
      return {
        measurements: rows.map((r) => ({
          id: r.id, type: r.type, valuePrimary: Number(r.value_primary),
          valueSecondary: r.value_secondary === null ? null : Number(r.value_secondary),
          unit: r.unit, measuredAt: r.measured_at, doseOccurrenceId: r.dose_occurrence_id, note: r.note,
        })),
        // MVP scope: recorded and charted, never used to advise.
        interpretationNotice: 'Measurements are recorded for the user’s own reference and are not evaluated by the app.',
      };
    });
  });

  app.post('/v1/measurements', async (req) => {
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const body = createMeasurementSchema.parse(req.body);
    const { userId } = currentUser(req);
    return withUser(userId, async (tx) => {
      await requireProfileOwner(tx, userId, profileId);
      const { rows } = await tx.query(
        `INSERT INTO health_measurements
           (patient_profile_id, type, value_primary, value_secondary, unit, measured_at, dose_occurrence_id, note, created_by)
         VALUES ($1,$2::measurement_type,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, measured_at`,
        [
          profileId, body.type, body.valuePrimary, body.valueSecondary ?? null, body.unit,
          body.measuredAt ?? serverNow(), body.doseOccurrenceId ?? null, body.note ?? null, userId,
        ],
      );
      return { measurement: { id: rows[0]!.id, measuredAt: rows[0]!.measured_at } };
    });
  });
}
