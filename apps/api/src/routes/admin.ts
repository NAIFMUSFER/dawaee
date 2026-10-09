import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, withTransaction } from '../lib/db.js';
import { authenticate, requireAdmin, currentUser } from '../middleware/context.js';
import { requireEnum, requireLimit } from '../lib/params.js';

/** Mirrors `notification_channel` (migration 0001). */
const NOTIFICATION_CHANNELS = ['push', 'local', 'whatsapp', 'sms', 'email', 'in_app'] as const;

/**
 * Operational admin.
 *
 * Deliberately narrow: system health, delivery failures and job outcomes. It
 * exposes NO medication names, no patient names and no health data — an
 * operator debugging a failed notification does not need to know what the
 * medication was, and giving them that access would make every support
 * engineer a holder of medical records.
 *
 * Clinical tables are FORCE-RLS and the API connects as the same unprivileged
 * `dawaee_app` role for every request. Admin JWTs therefore do not, and must
 * not, turn into a global database identity. The two clinical/global views
 * below go through migration 0048's bounded SECURITY DEFINER functions, whose
 * return shapes contain only aggregate or delivery-mechanics fields. Jobs and
 * webhook inbox rows are already explicit read-only operational tables with no
 * RLS (pinned by app-operational-privilege-boundary.test.ts).
 */
export function registerAdminRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/admin')) {
      await authenticate(req, null as never);
      await requireAdmin(req);
    }
  });

  // Service notices use existing durable delivery, retries and receipt tracking.
  // A preview freezes recipients; sending requires a separate explicit request.
  app.get('/v1/admin/service-notices', async (req) => withUser(currentUser(req).userId, async tx => {
    const { rows } = await tx.query("SELECT app.admin_service_notice('list') AS notices");
    return { notices: rows[0].notices };
  }));
  app.post('/v1/admin/service-notices/preview', async req => {
    const body = z.object({ id: z.string().uuid(), title: z.string().trim().min(1).max(80),
      body: z.string().trim().min(1).max(500), locale: z.enum(['ar','en']),
      audience: z.enum(['self','all']) }).strict().parse(req.body);
    return withUser(currentUser(req).userId, async tx => {
      const { rows } = await tx.query("SELECT app.admin_service_notice('preview',$1,$2,$3,$4,$5) AS notice",
        [body.id,body.title,body.body,body.locale,body.audience]);
      return { notice: rows[0].notice };
    });
  });
  app.post('/v1/admin/service-notices/:id/send', async req => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    z.object({ confirm: z.literal(true) }).strict().parse(req.body);
    return withUser(currentUser(req).userId, async tx => {
      const { rows } = await tx.query("SELECT app.admin_service_notice('send',$1) AS notice",[id]);
      return { notice: rows[0].notice };
    });
  });

  app.get('/v1/admin/overview', async () =>
    withTransaction(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM app.admin_operational_overview()');
      return { counts: rows[0] };
    }),
  );

  app.get('/v1/admin/deliveries/failed', async (req) => {
    const { channel, limit } = req.query as { channel?: string; limit?: string };
    return withTransaction(async (tx) => {
      const { rows } = await tx.query(
        'SELECT * FROM app.admin_failed_deliveries($1::notification_channel, $2::int)',
        [requireEnum(channel, NOTIFICATION_CHANNELS, 'channel'), requireLimit(limit, 100, 500)],
      );
      // No recipient, no patient, no medication — just the failure shape.
      return { failures: rows, count: rows.length };
    });
  });

  app.get('/v1/admin/deliveries/stats', async () =>
    withTransaction(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM app.admin_delivery_stats()');
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
