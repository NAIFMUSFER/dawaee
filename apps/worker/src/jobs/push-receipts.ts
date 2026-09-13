import { sanitizeOperationalError } from '@dawaee/shared';
import type { PoolClient } from 'pg';
import type { PushReceiptResult } from '@dawaee/api/providers';
import type { JobFailure, WorkerContext } from '../context.js';

const RECEIPT_DELAY_MS = 15 * 60 * 1000;
const RECEIPT_EXPIRY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StoredTicket {
  providerMessageId: string;
  pushTokenId: string;
}

interface DeliveryReceiptRow {
  id: string;
  recipient_user_id: string;
  sent_at: Date;
  provider_receipts: unknown;
}

interface ReceiptJobResult {
  itemsProcessed: number;
  failures?: JobFailure[];
}

function tickets(value: unknown): StoredTicket[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const providerMessageId = Reflect.get(entry, 'providerMessageId');
    const pushTokenId = Reflect.get(entry, 'pushTokenId');
    return typeof providerMessageId === 'string'
      && providerMessageId.length > 0
      && providerMessageId.length <= 256
      && typeof pushTokenId === 'string'
      && UUID.test(pushTokenId)
      ? [{ providerMessageId, pushTokenId }]
      : [];
  });
}

function receiptDetail(receipts: PushReceiptResult[]): string | null {
  const parts = receipts
    .filter((receipt) => receipt.status === 'error')
    .map((receipt) => `${receipt.errorCode ?? 'push_receipt_error'}${receipt.errorDetail ? `: ${receipt.errorDetail}` : ''}`);
  return parts.length ? sanitizeOperationalError(parts.join('; ').slice(0, 500)) : null;
}

export async function pushReceiptJob(ctx: WorkerContext, client: PoolClient): Promise<ReceiptJobResult> {
  const getReceipts = ctx.providers.push.getReceipts?.bind(ctx.providers.push);
  if (!getReceipts) return { itemsProcessed: 0 };

  const now = ctx.now();
  const eligibleBefore = new Date(now.getTime() - RECEIPT_DELAY_MS);
  const expiredBefore = new Date(now.getTime() - RECEIPT_EXPIRY_MS);
  const { rows } = await client.query<DeliveryReceiptRow>(
    `SELECT id, recipient_user_id, sent_at, provider_receipts
       FROM notification_deliveries
      WHERE channel = 'push'
        AND status = 'sent'
        AND delivered_at IS NULL
        AND provider = $1
        AND jsonb_array_length(provider_receipts) > 0
        AND sent_at <= $2
      ORDER BY sent_at
      LIMIT $3`,
    [ctx.providers.push.name, eligibleBefore, BATCH_SIZE],
  );
  if (rows.length === 0) return { itemsProcessed: 0 };

  const byDelivery = rows.map((row) => ({ row, tickets: tickets(row.provider_receipts) }));
  const ids = [...new Set(byDelivery.flatMap((entry) => entry.tickets.map((ticket) => ticket.providerMessageId)))];
  if (ids.length === 0) return { itemsProcessed: 0 };

  let providerReceipts: PushReceiptResult[];
  try {
    providerReceipts = await getReceipts(ids);
  } catch (err) {
    return {
      itemsProcessed: 0,
      failures: [{
        step: 'provider-receipts',
        error: sanitizeOperationalError(err instanceof Error ? err.message : 'unknown receipt error'),
      }],
    };
  }
  const receiptById = new Map(providerReceipts.map((receipt) => [receipt.providerMessageId, receipt]));

  let processed = 0;
  for (const { row, tickets: rowTickets } of byDelivery) {
    if (rowTickets.length === 0) continue;
    const resolved = rowTickets
      .map((ticket) => ({ ticket, receipt: receiptById.get(ticket.providerMessageId) }))
      .filter((entry): entry is { ticket: StoredTicket; receipt: PushReceiptResult } => entry.receipt !== undefined);

    for (const { ticket, receipt } of resolved) {
      if (receipt.status === 'error' && receipt.errorCode === 'DeviceNotRegistered') {
        await client.query(
          'SELECT app.deactivate_push_endpoint($1, $2)',
          [row.recipient_user_id, ticket.pushTokenId],
        );
      }
    }

    if (resolved.some(({ receipt }) => receipt.status === 'ok')) {
      const result = await client.query(
        `UPDATE notification_deliveries
            SET status = 'delivered', delivered_at = $2, error_code = NULL, error_detail = NULL
          WHERE id = $1 AND status = 'sent' AND delivered_at IS NULL`,
        [row.id, now],
      );
      processed += result.rowCount ?? 0;
      continue;
    }

    const allTerminalErrors = resolved.length === rowTickets.length
      && resolved.every(({ receipt }) => receipt.status === 'error');
    const expired = row.sent_at <= expiredBefore;
    if (allTerminalErrors || expired) {
      const result = await client.query(
        `UPDATE notification_deliveries
            SET status = 'failed', error_code = $2, error_detail = $3
          WHERE id = $1 AND status = 'sent' AND delivered_at IS NULL`,
        [
          row.id,
          allTerminalErrors ? 'push_receipt_failed' : 'push_receipt_expired',
          allTerminalErrors ? receiptDetail(resolved.map(({ receipt }) => receipt)) : 'No provider receipt was available within 24 hours',
        ],
      );
      processed += result.rowCount ?? 0;
    }
  }

  return { itemsProcessed: processed };
}
