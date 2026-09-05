import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../lib/db.js';
import { authenticate, requireAdmin } from '../middleware/context.js';

/**
 * Operational admin.
 *
 * Deliberately narrow: system health, delivery failures and job outcomes. It
 * exposes NO medication names, no patient names and no health data — an
 * operator debugging a failed notification does not need to know what the
 * medication was, and giving them that access would make every support
 * engineer a holder of medical records.
 */
export function registerAdminRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/admin')) {
      await authenticate(req, null as never);
      await requireAdmin(req);
    }
  });

  app.get('/v1/admin/overview', async () =>
    withTransaction(async (tx) => {
      const { rows: counts } = await tx.query(`
        SELECT
          (SELECT count(*) FROM users WHERE disabled_at IS NULL) AS users,
          (SELECT count(*) FROM patient_profiles WHERE archived_at IS NULL) AS profiles,
          (SELECT count(*) FROM medications WHERE status = 'active') AS active_medications,
          (SELECT count(*) FROM caregiver_relationships WHERE status = 'active') AS active_caregivers,
          (SELECT count(*) FROM dose_occurrences WHERE scheduled_at > now() - interval '24 hours') AS doses_24h,
          (SELECT count(*) FROM dose_occurrences
            WHERE scheduled_at > now() - interval '24 hours' AND status IN ('taken','taken_late')) AS taken_24h
      `);
      return { counts: counts[0] };
    }),
  );

  app.get('/v1/admin/deliveries/failed', async (req) => {
    const { channel, limit } = req.query as { channel?: string; limit?: string };
    return withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, kind::text AS kind, channel::text AS channel, provider, error_code,
                attempts, created_at, scheduled_for
           FROM notification_deliveries
          WHERE status = 'failed'
            AND ($1::text IS NULL OR channel = $1::notification_channel)
          ORDER BY created_at DESC LIMIT $2`,
        [channel ?? null, Math.min(Number(limit ?? 100), 500)],
      );
      // No recipient, no patient, no medication — just the failure shape.
      return { failures: rows, count: rows.length };
    });
  });

  app.get('/v1/admin/deliveries/stats', async () =>
    withTransaction(async (tx) => {
      const { rows } = await tx.query(`
        SELECT channel::text AS channel, status::text AS status, count(*)::int AS count
          FROM notification_deliveries
         WHERE created_at > now() - interval '7 days'
         GROUP BY 1,2 ORDER BY 1,2
      `);
      return { window: '7d', stats: rows };
    }),
  );

  app.get('/v1/admin/jobs', async () =>
    withTransaction(async (tx) => {
      const { rows } = await tx.query(`
        SELECT DISTINCT ON (job_name)
               job_name, started_at, finished_at, succeeded, items_processed, error_message
          FROM job_runs ORDER BY job_name, started_at DESC
      `);
      const { rows: failures } = await tx.query(`
        SELECT job_name, count(*)::int AS failures
          FROM job_runs
         WHERE succeeded = false AND started_at > now() - interval '24 hours'
         GROUP BY 1
      `);
      return { latest: rows, failuresLast24h: failures };
    }),
  );

  app.get('/v1/admin/webhooks/unprocessed', async () =>
    withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, provider, event_type, signature_ok, received_at
           FROM provider_webhook_events
          WHERE processed_at IS NULL ORDER BY received_at DESC LIMIT 100`,
      );
      return { events: rows };
    }),
  );
}
