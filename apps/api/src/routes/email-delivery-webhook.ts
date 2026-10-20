import type { FastifyInstance } from 'fastify';
import { Webhook } from 'svix';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { withTransaction } from '../lib/db.js';

const eventSchema = z.object({
  type: z.enum(['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced',
    'email.failed', 'email.suppressed', 'email.complained']),
  created_at: z.string().datetime({ offset: true }),
  data: z.object({ email_id: z.string().uuid(), from: z.string().max(400) }),
});

/** Isolated parser: signatures must cover the exact bytes, not re-serialized JSON. */
export async function registerEmailDeliveryWebhook(app: FastifyInstance): Promise<void> {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.post('/v1/webhooks/account-email', { bodyLimit: 64 * 1024,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const cfg = loadConfig();
    if (!cfg.RESEND_WEBHOOK_SECRET || !cfg.ACCOUNT_EMAIL_FROM) return reply.code(503).send({ received: false });
    const id = req.headers['svix-id'];
    const timestamp = req.headers['svix-timestamp'];
    const signature = req.headers['svix-signature'];
    if (typeof req.body !== 'string' || typeof id !== 'string' || id.length > 200
      || typeof timestamp !== 'string' || typeof signature !== 'string') {
      return reply.code(400).send({ received: false });
    }
    let verified: unknown;
    try {
      // Svix also enforces timestamp tolerance. Do not log headers or payloads.
      new Webhook(cfg.RESEND_WEBHOOK_SECRET).verify(req.body, {
        'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature,
      });
      verified = JSON.parse(req.body);
    } catch { return reply.code(400).send({ received: false }); }
    const parsed = eventSchema.safeParse(verified);
    if (!parsed.success) return reply.code(200).send({ received: true });
    const event = parsed.data;
    const from = event.data.from.trim();
    const mailbox = (from.match(/<([^<>]+)>$/)?.[1] ?? from).toLowerCase();
    // The email provider account hosts other projects; ignore their events.
    if (mailbox !== cfg.ACCOUNT_EMAIL_FROM.trim().toLowerCase()) return { received: true };
    // Persist before acknowledging, so database failures are retried by Resend.
    // The function deduplicates retries; no email address/body/OTP is retained.
    const { rows } = await withTransaction(tx => tx.query<{ inserted: boolean }>(
      'SELECT app.record_account_email_delivery($1,$2,$3,$4) AS inserted',
      [id, event.data.email_id, event.type, event.created_at]));
    if (rows[0]?.inserted) {
      const diagnostic = { emailId: event.data.email_id, deliveryStatus: event.type };
      if (['email.delivery_delayed', 'email.bounced', 'email.failed', 'email.suppressed'].includes(event.type)) {
        req.log.warn(diagnostic, 'Account email delivery needs attention');
      } else req.log.info(diagnostic, 'Account email delivery event');
    }
    return { received: true };
  });
}
