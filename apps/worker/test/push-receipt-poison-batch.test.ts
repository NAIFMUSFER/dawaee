import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerContext } from '../src/context.js';
import { pushReceiptJob } from '../src/jobs/push-receipts.js';

const NOW = new Date('2026-09-21T12:00:00Z');

interface Delivery {
  id: string;
  recipient_user_id: string;
  sent_at: Date;
  provider_receipts: unknown;
  status: 'sent' | 'delivered' | 'failed';
  errorCode?: string;
  errorDetail?: string;
}

function fixture() {
  const deliveries: Delivery[] = Array.from({ length: 100 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    recipient_user_id: '00000000-0000-4000-8000-000000000001',
    sent_at: new Date('2026-09-21T10:00:00Z'),
    provider_receipts: [{ unexpected: `private-corrupt-value-${index}` }],
    status: 'sent',
  }));
  deliveries.push({
    id: '20000000-0000-4000-8000-000000000000',
    recipient_user_id: '00000000-0000-4000-8000-000000000002',
    sent_at: new Date('2026-09-21T10:01:00Z'),
    provider_receipts: [{
      providerMessageId: 'healthy-ticket',
      pushTokenId: '00000000-0000-4000-8000-000000000003',
      tokenFingerprint: 'a'.repeat(64),
    }],
    status: 'sent',
  });

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM notification_deliveries')) {
      const rows = deliveries.filter(row => row.status === 'sent').slice(0, Number(params?.[2] ?? 100));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("SET status = 'failed'")) {
      const ids = Array.isArray(params?.[0]) ? params[0] : [params?.[0]];
      const rows = deliveries.filter(entry => ids.includes(entry.id) && entry.status === 'sent');
      for (const row of rows) {
        row.status = 'failed';
        row.errorCode = String(params?.[1]);
        row.errorDetail = String(params?.[2]);
      }
      return { rows: [], rowCount: rows.length };
    }
    if (sql.includes("SET status = 'delivered'")) {
      const row = deliveries.find(entry => entry.id === params?.[0] && entry.status === 'sent');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'delivered';
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in receipt fixture: ${sql}`);
  });
  const getReceipts = vi.fn(async (ids: string[]) => ids.map(providerMessageId => ({
    providerMessageId, status: 'ok' as const,
  })));
  const ctx = {
    now: () => NOW,
    providers: { push: { name: 'expo', getReceipts } },
  } as unknown as WorkerContext;
  return { deliveries, getReceipts, ctx, client: { query } as unknown as PoolClient };
}

describe('push receipt poison-batch isolation', () => {
  it('terminally isolates a full malformed batch so the next valid delivery can advance', async () => {
    const h = fixture();

    const isolated = await pushReceiptJob(h.ctx, h.client);
    expect(isolated).toEqual({ itemsProcessed: 100 });
    expect(h.getReceipts).not.toHaveBeenCalled();
    expect(h.deliveries.slice(0, 100).every(row => row.status === 'failed')).toBe(true);
    expect(new Set(h.deliveries.slice(0, 100).map(row => row.errorCode))).toEqual(
      new Set(['push_receipt_malformed']),
    );
    expect(h.deliveries.slice(0, 100).every(row => row.errorDetail === 'Stored push receipt tickets were invalid')).toBe(true);
    expect(JSON.stringify(h.deliveries.slice(0, 100).map(row => row.errorDetail))).not.toContain('private-corrupt-value');

    const healthy = await pushReceiptJob(h.ctx, h.client);
    expect(healthy).toEqual({ itemsProcessed: 1 });
    expect(h.getReceipts).toHaveBeenCalledWith(['healthy-ticket']);
    expect(h.deliveries.at(-1)?.status).toBe('delivered');
  });
});
