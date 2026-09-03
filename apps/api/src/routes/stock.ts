import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES, adjustStockSchema, refillSchema } from '@dawaee/shared';
import { applyRefill, daysOfSupply, forecastStock } from '@dawaee/core';
import { requireUuid } from '../lib/params.js';
import { withUser, withUserReadOnly } from '../lib/db.js';
import { authenticate, currentUser } from '../middleware/context.js';
import { profileIdForMedication, requireProfileAccess } from '../services/access-service.js';
import { recordAudit } from '../services/audit-service.js';
import { now as serverNow } from '../lib/clock.js';

/**
 * Stock, refills and the run-out forecast.
 *
 * All arithmetic on user-entered quantities. The app never infers how much
 * medication someone "should" have left and never adjusts a dose to make the
 * numbers work out.
 */
export function registerStockRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.url.includes('/stock') || req.url.includes('/refill')) await authenticate(req, null as never);
  });

  async function consumptionSources(tx: Parameters<typeof requireProfileAccess>[0], medicationId: string) {
    const { rows } = await tx.query(
      `SELECT rule, dose_quantity, dose_unit::text AS dose_unit, active
         FROM medication_schedules WHERE medication_id = $1`,
      [medicationId],
    );
    return rows.map((s) => ({
      rule: s.rule, doseQuantity: Number(s.dose_quantity), doseUnit: s.dose_unit, active: s.active,
    }));
  }

  app.get('/v1/medications/:medicationId/stock', async (req) => {
    const { medicationId } = req.params as { medicationId: string };
    const { userId } = currentUser(req);
    return withUserReadOnly(userId, async (tx) => {
      const profileId = await profileIdForMedication(tx, medicationId);
      const access = await requireProfileAccess(tx, userId, profileId, 'view_medications');

      const { rows } = await tx.query(
        `SELECT unit::text AS unit, initial_quantity, remaining_quantity, tracking_enabled,
                low_stock_threshold_days, last_refill_at
           FROM medication_stock WHERE medication_id = $1`,
        [medicationId],
      );
      if (!rows[0]) return { stock: null, forecast: null, transactions: [], refills: [] };

      const { rows: prefs } = await tx.query<{ low_stock_threshold_days: number }>(
        'SELECT low_stock_threshold_days FROM user_preferences WHERE user_id = $1', [userId],
      );
      const sources = await consumptionSources(tx, medicationId);
      const forecast = forecastStock({
        medicationId,
        stock: {
          remainingQuantity: rows[0].remaining_quantity === null ? null : Number(rows[0].remaining_quantity),
          trackingEnabled: rows[0].tracking_enabled,
          lowStockThresholdDays: rows[0].low_stock_threshold_days,
        },
        sources,
        defaultThresholdDays: prefs[0]?.low_stock_threshold_days ?? 7,
        now: serverNow(),
        timezone: access.profileTimezone,
      });

      const { rows: transactions } = await tx.query(
        `SELECT delta, reason::text AS reason, balance_after, note, created_at
           FROM stock_transactions WHERE medication_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [medicationId],
      );
      const { rows: refills } = await tx.query(
        `SELECT id, quantity_added, unit::text AS unit, pharmacy, cost, note, refilled_at
           FROM refill_events WHERE medication_id = $1 ORDER BY refilled_at DESC LIMIT 50`,
        [medicationId],
      );

      return {
        stock: {
          unit: rows[0].unit,
          initialQuantity: rows[0].initial_quantity === null ? null : Number(rows[0].initial_quantity),
          remainingQuantity: rows[0].remaining_quantity === null ? null : Number(rows[0].remaining_quantity),
          trackingEnabled: rows[0].tracking_enabled,
          lowStockThresholdDays: rows[0].low_stock_threshold_days,
          lastRefillAt: rows[0].last_refill_at,
        },
        forecast,
        transactions: transactions.map((t) => ({
          delta: Number(t.delta), reason: t.reason,
          balanceAfter: t.balance_after === null ? null : Number(t.balance_after),
          note: t.note, createdAt: t.created_at,
        })),
        refills: refills.map((r) => ({
          id: r.id, quantityAdded: Number(r.quantity_added), unit: r.unit,
          pharmacy: r.pharmacy, cost: r.cost === null ? null : Number(r.cost),
          note: r.note, refilledAt: r.refilled_at,
        })),
      };
    });
  });

  app.put('/v1/medications/:medicationId/stock', async (req) => {
    const { medicationId } = req.params as { medicationId: string };
    const body = adjustStockSchema.parse(req.body);
    const { userId } = currentUser(req);

    if (body.remainingQuantity === undefined && body.delta === undefined) {
      throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Provide either remainingQuantity or delta');
    }

    return withUser(userId, async (tx) => {
      const profileId = await profileIdForMedication(tx, medicationId);
      await requireProfileAccess(tx, userId, profileId, 'update_stock');

      const { rows: current } = await tx.query<{ remaining_quantity: string | null; tracking_enabled: boolean; unit: string }>(
        `SELECT remaining_quantity, tracking_enabled, unit::text AS unit
           FROM medication_stock WHERE medication_id = $1 FOR UPDATE`,
        [medicationId],
      );
      if (!current[0]) throw AppError.notFound('This medication does not have stock tracking set up');
      if (!current[0].tracking_enabled) {
        throw new AppError(ERROR_CODES.STOCK_TRACKING_DISABLED, 409, 'Stock tracking is disabled for this medication');
      }

      const before = current[0].remaining_quantity === null ? 0 : Number(current[0].remaining_quantity);
      const after = body.remainingQuantity !== undefined
        ? body.remainingQuantity
        : Math.max(0, before + (body.delta ?? 0));

      await tx.query('UPDATE medication_stock SET remaining_quantity = $2 WHERE medication_id = $1', [medicationId, after]);
      await tx.query(
        `INSERT INTO stock_transactions
           (medication_id, patient_profile_id, delta, reason, balance_after, note, actor_user_id)
         VALUES ($1,$2,$3,$4::stock_reason,$5,$6,$7)`,
        [medicationId, profileId, after - before, body.reason, after, body.note ?? null, userId],
      );
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'stock.adjusted',
        entityType: 'medication_stock', entityId: medicationId, requestId: req.id, ipHash: req.ipHash,
        previousValue: { remainingQuantity: before }, newValue: { remainingQuantity: after, reason: body.reason },
      });

      return { remainingQuantity: after, unit: current[0].unit, delta: after - before };
    });
  });

  /** Record a refill. Clears the low-stock nag so it can fire again next time. */
  app.post('/v1/medications/:medicationId/refill', async (req) => {
    const { medicationId } = req.params as { medicationId: string };
    const body = refillSchema.parse(req.body);
    const { userId } = currentUser(req);

    return withUser(userId, async (tx) => {
      const profileId = await profileIdForMedication(tx, medicationId);
      await requireProfileAccess(tx, userId, profileId, 'update_stock');

      const { rows: current } = await tx.query<{ remaining_quantity: string | null; unit: string }>(
        `SELECT remaining_quantity, unit::text AS unit FROM medication_stock WHERE medication_id = $1 FOR UPDATE`,
        [medicationId],
      );

      const before = current[0]?.remaining_quantity === null || current[0] === undefined
        ? null
        : Number(current[0].remaining_quantity);
      const after = applyRefill(before, body.quantityAdded);

      if (current[0]) {
        await tx.query(
          `UPDATE medication_stock
              SET remaining_quantity = $2, last_refill_at = $3, low_stock_notified_at = NULL
            WHERE medication_id = $1`,
          [medicationId, after, body.refilledAt ?? serverNow()],
        );
      } else {
        await tx.query(
          `INSERT INTO medication_stock
             (medication_id, patient_profile_id, unit, initial_quantity, remaining_quantity, last_refill_at)
           VALUES ($1,$2,$3::dose_unit,$4,$4,$5)`,
          [medicationId, profileId, body.unit, body.quantityAdded, body.refilledAt ?? serverNow()],
        );
      }

      const { rows: refill } = await tx.query(
        `INSERT INTO refill_events
           (medication_id, patient_profile_id, quantity_added, unit, pharmacy, cost, note, refilled_at, created_by)
         VALUES ($1,$2,$3,$4::dose_unit,$5,$6,$7,$8,$9)
         RETURNING id, refilled_at`,
        [
          medicationId, profileId, body.quantityAdded, body.unit, body.pharmacy ?? null,
          body.cost ?? null, body.note ?? null, body.refilledAt ?? serverNow(), userId,
        ],
      );
      await tx.query(
        `INSERT INTO stock_transactions
           (medication_id, patient_profile_id, delta, reason, balance_after, actor_user_id)
         VALUES ($1,$2,$3,'refill',$4,$5)`,
        [medicationId, profileId, body.quantityAdded, after, userId],
      );
      await recordAudit(tx, {
        actorUserId: userId, patientProfileId: profileId, action: 'stock.refilled',
        entityType: 'medication_stock', entityId: medicationId, requestId: req.id, ipHash: req.ipHash,
        previousValue: { remainingQuantity: before }, newValue: { remainingQuantity: after, quantityAdded: body.quantityAdded },
      });

      const sources = await consumptionSources(tx, medicationId);
      return {
        refillId: refill[0]!.id,
        remainingQuantity: after,
        unit: body.unit,
        daysOfSupply: daysOfSupply(after, sources),
      };
    });
  });

  /** Everything running low across a profile — powers the refill screen. */
  app.get('/v1/stock/low', async (req) => {
    const profileId = requireUuid((req.query as { profileId?: string }).profileId, 'profileId');
    const { userId } = currentUser(req);

    return withUserReadOnly(userId, async (tx) => {
      const access = await requireProfileAccess(tx, userId, profileId, 'view_medications');
      const { rows: prefs } = await tx.query<{ low_stock_threshold_days: number; expiry_warning_days: number }>(
        'SELECT low_stock_threshold_days, expiry_warning_days FROM user_preferences WHERE user_id = $1', [userId],
      );
      const defaultThreshold = prefs[0]?.low_stock_threshold_days ?? 7;
      const expiryDays = prefs[0]?.expiry_warning_days ?? 30;

      const { rows } = await tx.query(
        `SELECT m.id, m.name, m.expiry_date, st.unit::text AS unit, st.remaining_quantity,
                st.tracking_enabled, st.low_stock_threshold_days
           FROM medications m
           JOIN medication_stock st ON st.medication_id = m.id
          WHERE m.patient_profile_id = $1 AND m.status = 'active' AND st.tracking_enabled`,
        [profileId],
      );

      const low = [];
      for (const row of rows) {
        const sources = await consumptionSources(tx, row.id);
        const forecast = forecastStock({
          medicationId: row.id,
          stock: {
            remainingQuantity: row.remaining_quantity === null ? null : Number(row.remaining_quantity),
            trackingEnabled: row.tracking_enabled,
            lowStockThresholdDays: row.low_stock_threshold_days,
          },
          sources, defaultThresholdDays: defaultThreshold, now: serverNow(), timezone: access.profileTimezone,
        });
        if (forecast?.isLow) low.push({ medicationId: row.id, medicationName: row.name, unit: row.unit, forecast });
      }

      const { rows: expiring } = await tx.query(
        `SELECT id, name, expiry_date
           FROM medications
          WHERE patient_profile_id = $1 AND status IN ('active','paused')
            AND expiry_date IS NOT NULL
            AND expiry_date <= current_date + ($2 || ' days')::interval
          ORDER BY expiry_date`,
        [profileId, String(expiryDays)],
      );

      return {
        lowStock: low.sort((a, b) => (a.forecast!.daysRemaining ?? 0) - (b.forecast!.daysRemaining ?? 0)),
        expiringSoon: expiring.map((e) => ({ medicationId: e.id, medicationName: e.name, expiryDate: e.expiry_date })),
      };
    });
  });
}
