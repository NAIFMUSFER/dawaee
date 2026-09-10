import { sanitizeOperationalError } from '@dawaee/shared';
import type { PoolClient } from 'pg';
import type { PushMessage } from '@dawaee/api/providers';
import type { WorkerContext } from '../context.js';

const LEASE_SECONDS = 120;
const AMBIGUOUS_IS_RETRYABLE = true;

export function isAmbiguous(errorCode: string | undefined): boolean {
  return errorCode === 'network_error' || /^http_5\d\d$/.test(errorCode ?? '');
}

interface DeliveryRow {
  id: string;
  recipient_user_id: string | null;
  recipient_phone_e164: string | null;
  kind: string;
  channel: string;
  locale: string;
  title: string | null;
  body: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  lease_token: string;
}

export async function claimDeliveries(
  ctx: WorkerContext, client: PoolClient, limit = 200,
): Promise<DeliveryRow[]> {
  const { rows } = await client.query<DeliveryRow>(
    `UPDATE notification_deliveries d
        SET status = 'sending',
            attempts = d.attempts + 1,
            lease_until = $1::timestamptz + make_interval(secs => $2),
            lease_token = gen_random_uuid()
      WHERE d.id IN (
        SELECT id FROM notification_deliveries
         WHERE (status = 'queued' AND next_attempt_at <= $1)
            OR (status = 'sending' AND lease_until IS NOT NULL AND lease_until <= $1)
         ORDER BY next_attempt_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.recipient_user_id, d.recipient_phone_e164, d.kind::text AS kind,
                d.channel::text AS channel, d.locale, d.title, d.body, d.payload,
                d.attempts, d.max_attempts, d.lease_token`,
    [ctx.now(), LEASE_SECONDS, limit],
  );
  return rows;
}

export async function dispatchJob(ctx: WorkerContext, client: PoolClient): Promise<{ itemsProcessed: number }> {
  const claimClient = await ctx.pool.connect();
  let rows: DeliveryRow[];
  try {
    await claimClient.query('BEGIN');
    rows = await claimDeliveries(ctx, claimClient);
    await claimClient.query('COMMIT');
  } catch (err) {
    await claimClient.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    claimClient.release();
  }
  if (rows.length === 0) return { itemsProcessed: 0 };

  let sent = 0;
  for (const row of rows) {
    const result = await sendOne(ctx, client, row);

    if (result.ok) {
      const applied = await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'sent', sent_at = now(), provider = $3, provider_message_id = $4,
                error_code = NULL, lease_until = NULL
          WHERE id = $1 AND lease_token = $2 AND status = 'sending'`,
        [result.provider, result.providerMessageId ?? null]);
      if (applied) sent += 1;
    } else if (
      (isAmbiguous(result.errorCode) ? AMBIGUOUS_IS_RETRYABLE : (result.retryable ?? false))
      && row.attempts < row.max_attempts
    ) {
      const delaySeconds = Math.min(300, 30 * 2 ** Math.max(0, row.attempts - 1));
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'queued', next_attempt_at = now() + make_interval(secs => $3),
                error_code = $4, error_detail = $5, provider = $6, lease_until = NULL
          WHERE id = $1 AND lease_token = $2 AND status = 'sending'`,
        [delaySeconds, result.errorCode ?? null, result.errorDetail ? sanitizeOperationalError(result.errorDetail) : null, result.provider]);
    } else {
      await finalise(ctx, row,
        `UPDATE notification_deliveries
            SET status = 'failed', error_code = $3, error_detail = $4, provider = $5,
                lease_until = NULL
          WHERE id = $1 AND lease_token = $2 AND status = 'sending'`,
        [result.errorCode ?? null, result.errorDetail ? sanitizeOperationalError(result.errorDetail) : null, result.provider]);
      ctx.log.warn(
        { deliveryId: row.id, channel: row.channel, errorCode: result.errorCode },
        'notification delivery failed permanently',
      );
    }
  }

  return { itemsProcessed: sent };
}

async function finalise(
  ctx: WorkerContext, row: DeliveryRow, sql: string, params: unknown[],
): Promise<boolean> {
  const c = await ctx.pool.connect();
  try {
    const { rowCount } = await c.query(sql, [row.id, row.lease_token, ...params]);
    if (rowCount === 0) {
      ctx.log.warn(
        { deliveryId: row.id },
        'delivery lease is no longer active; provider result discarded',
      );
      return false;
    }
    return true;
  } finally {
    c.release();
  }
}

interface SendOutcome {
  ok: boolean;
  provider: string;
  providerMessageId?: string;
  errorCode?: string;
  errorDetail?: string;
  retryable?: boolean;
}

async function sendOne(ctx: WorkerContext, client: PoolClient, row: DeliveryRow): Promise<SendOutcome> {
  switch (row.channel) {
    case 'push':
      return sendPush(ctx, client, row);
    case 'local':
    case 'in_app':
      return { ok: true, provider: 'device_local' };
    default:
      return { ok: false, provider: 'none', errorCode: 'unsupported_channel', retryable: false };
  }
}

async function sendPush(ctx: WorkerContext, client: PoolClient, row: DeliveryRow): Promise<SendOutcome> {
  if (!row.recipient_user_id) {
    return { ok: false, provider: ctx.providers.push.name, errorCode: 'no_recipient', retryable: false };
  }

  const { rows: tokens } = await client.query<{ token: string }>(
    'SELECT token FROM push_tokens WHERE user_id = $1 AND active ORDER BY last_seen_at DESC LIMIT 5',
    [row.recipient_user_id],
  );
  if (tokens.length === 0) {
    return { ok: false, provider: ctx.providers.push.name, errorCode: 'no_active_device', retryable: false };
  }

  const grouped = row.payload.grouped === true;
  const messages: PushMessage[] = tokens.map((t) => ({
    token: t.token,
    title: row.title ?? '',
    body: row.body ?? '',
    data: {
      deliveryId: row.id,
      kind: grouped ? 'dose_group_reminder' : row.kind,
      doseId: grouped ? '' : String(row.payload.doseId ?? ''),
      doseIds: grouped ? JSON.stringify(row.payload.doseIds ?? []) : '[]',
      actions: JSON.stringify(row.payload.actions ?? []),
    },
    priority: row.kind === 'dose_reminder' || row.kind === 'dose_reminder_repeat' || row.kind === 'escalation'
      ? 'high' : 'default',
    // A grouped reminder must not expose a single-dose Taken/Snooze/Skip action.
    // The patient opens the app and confirms each medicine independently.
    categoryId: row.kind.startsWith('dose_reminder') && !grouped ? 'MEDICATION_REMINDER' : undefined,
    sound: 'default',
  }));

  const results = await ctx.providers.push.send(messages);

  const dead = results.flatMap((r) => r.invalidTokens ?? []);
  if (dead.length) {
    await client.query('UPDATE push_tokens SET active = false WHERE token = ANY($1::text[])', [dead]);
    ctx.log.info({ count: dead.length }, 'deactivated push tokens the provider reported as unregistered');
  }

  const anyOk = results.some((r) => r.ok);
  const first = results.find((r) => !r.ok);
  return anyOk
    ? { ok: true, provider: ctx.providers.push.name, providerMessageId: results.find((r) => r.ok)?.providerMessageId }
    : {
        ok: false,
        provider: ctx.providers.push.name,
        errorCode: first?.errorCode,
        errorDetail: first?.errorDetail,
        retryable: first?.retryable ?? false,
      };
}
