import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { ExpoPushProvider } from '../src/providers/push.js';
import { dispatchJob } from '../../worker/src/jobs/dispatcher.js';

// Execute the real provider + worker path with controlled SQL responses and
// synthetic HTTP. This is not a live database or device delivery test.
function harness(attempts: number, status = 429) {
  const now = new Date('2026-09-21T12:00:00Z');
  const row = { id: 'delivery', patient_profile_id: null, dose_occurrence_id: null,
    recipient_user_id: 'synthetic-recipient', recipient_phone_e164: null, relationship_id: null,
    kind: 'daily_summary', channel: 'push', locale: 'en', title: 'Synthetic summary', body: 'Synthetic',
    payload: {}, attempts, max_attempts: 6, lease_token: 'synthetic-lease' };
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('RETURNING d.id')) return { rows: [row], rowCount: 1 };
    if (sql.includes('quiet_hours_start')) return { rows: [], rowCount: 0 };
    if (sql.includes('SET lease_until =')) return { rows: [], rowCount: 1 };
    if (sql.includes('app.list_live_push_endpoints')) return { rows: [
      { push_token_id: 'synthetic-endpoint', token: 'ExponentPushToken[synthetic]' },
    ], rowCount: 1 };
    if (sql.includes('UPDATE notification_deliveries')) {
      writes.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const request = vi.fn(async () => new Response(JSON.stringify(status === 200
    ? { data: [{ status: 'ok', id: 'synthetic-ticket' }] }
    : { errors: [{ message: 'Temporary provider limit' }] }), { status }));
  vi.stubGlobal('fetch', request);
  const client = { query, release() {} };
  const context = { now: () => now, pool: { connect: async () => client },
    providers: { push: new ExpoPushProvider({ EXPO_ACCESS_TOKEN: undefined } as Config) },
    log: { info() {}, warn() {} } };
  return { writes, request, now, run: () => dispatchJob(
    context as unknown as Parameters<typeof dispatchJob>[0],
    client as unknown as Parameters<typeof dispatchJob>[1],
  ) };
}
afterEach(() => vi.unstubAllGlobals());

describe('N2: HTTP 429 reaches bounded worker backoff, not permanent failure', () => {
  it.each([[1, 30], [2, 60], [3, 120], [4, 240], [5, 300]])(
    'requeues attempt %i with %i seconds of delay', async (attempts, seconds) => {
      const h = harness(attempts);
      expect(await h.run()).toEqual({ itemsProcessed: 0 });
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]!.sql).toContain("status = 'queued'");
      expect(h.writes[0]!.sql).toContain("status = 'sending'");
      expect(h.writes[0]!.sql).toContain('lease_token = $2');
      expect(h.writes[0]!.params).toEqual([
        'delivery', 'synthetic-lease', h.now, seconds, 'http_429', null, 'expo',
      ]);
    },
  );

  it('still terminates at the attempt limit', async () => {
    const h = harness(6);
    expect(await h.run()).toEqual({ itemsProcessed: 0 });
    expect(h.writes[0]!.sql).toContain("status = 'failed'");
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('retains permanent failure for rejected credentials', async () => {
    const h = harness(1, 401);
    expect(await h.run()).toEqual({ itemsProcessed: 0 });
    expect(h.writes[0]!.sql).toContain("status = 'failed'");
    expect(h.writes[0]!.params).toContain('http_401');
  });

  it('records a later accepted ticket as sent, never device-delivered', async () => {
    const h = harness(2, 200);
    expect(await h.run()).toEqual({ itemsProcessed: 1 });
    expect(h.writes[0]!.sql).toContain("status = 'sent'");
    expect(h.writes[0]!.sql).not.toContain("status = 'delivered'");
    expect(h.writes[0]!.params).toContain('synthetic-ticket');
  });
});
