import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../lib/db.js';
import { loadConfig } from '../config.js';
import type { Providers } from '../providers/index.js';

/**
 * Provider callbacks.
 *
 * A webhook is untrusted input from the public internet. Every payload is
 * signature-verified, stored raw first, and only then folded into delivery
 * state — so a forged or replayed callback can never mark a message delivered
 * that was not, and a malformed one cannot corrupt anything.
 */
export function registerWebhookRoutes(app: FastifyInstance, providers: Providers): void {
  const cfg = loadConfig();

  // Meta requires the raw body for HMAC verification, so it is captured before
  // JSON parsing rather than re-serialized afterwards.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (typeof body === 'string' && req.url.startsWith('/v1/webhooks/whatsapp')) {
      (req as unknown as { rawBody: string }).rawBody = body;
    }
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  /** Meta's subscription handshake. */
  app.get('/v1/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === cfg.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      return reply.status(200).send(q['hub.challenge']);
    }
    return reply.status(403).send('forbidden');
  });

  app.post('/v1/webhooks/whatsapp', {
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const valid = providers.whatsapp.verifyWebhookSignature(raw, signature);

    // Always 200: Meta retries aggressively on anything else, and an invalid
    // signature is our problem to log, not a reason to be hammered.
    if (!valid) {
      req.log.warn('rejected WhatsApp webhook with an invalid signature');
      await withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO provider_webhook_events (provider, event_type, payload, signature_ok)
           VALUES ('whatsapp','signature_rejected', $1, false)`,
          [JSON.stringify({ received: true })],
        );
      });
      return reply.status(200).send({ received: true });
    }

    const body = req.body as {
      entry?: Array<{ changes?: Array<{ value?: { statuses?: Array<{ id: string; status: string; timestamp: string; errors?: unknown }> } }> }>;
    };

    await withTransaction(async (tx) => {
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const status of change.value?.statuses ?? []) {
            await tx.query(
              `INSERT INTO provider_webhook_events (provider, external_id, event_type, payload, signature_ok)
               VALUES ('whatsapp', $1, $2, $3, true)
               ON CONFLICT (provider, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
              [`${status.id}:${status.status}`, status.status, JSON.stringify(status)],
            );
            const mapped =
              status.status === 'delivered' ? 'delivered'
                : status.status === 'read' ? 'read'
                  : status.status === 'failed' ? 'failed'
                    : 'sent';
            await tx.query(
              `UPDATE notification_deliveries
                  SET status = $2::delivery_status,
                      delivered_at = CASE WHEN $2 IN ('delivered','read') THEN now() ELSE delivered_at END
                WHERE provider_message_id = $1`,
              [status.id, mapped],
            );
            await tx.query(
              `UPDATE provider_webhook_events SET processed_at = now()
                WHERE provider = 'whatsapp' AND external_id = $1`,
              [`${status.id}:${status.status}`],
            );
          }
        }
      }
    });

    return reply.status(200).send({ received: true });
  });
}
