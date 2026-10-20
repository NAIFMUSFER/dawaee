import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { auditTransaction, createAuditDatabase } from './independent-audit-db.js';
let db: PGlite;
beforeAll(async () => { db = await createAuditDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });
const emailId = '11111111-1111-4111-8111-111111111111';
const record = (id: string, type: string, at = new Date()) => auditTransaction(db, 'dawaee_app', tx =>
  tx.query('SELECT app.record_account_email_delivery($1,$2,$3,$4) AS inserted', [id, emailId, type, at]));
it('deduplicates retries and preserves out-of-order delivery history', async () => {
  expect((await record('delivered', 'email.delivered')).rows[0].inserted).toBe(true);
  expect((await record('delivered', 'email.delivered')).rows[0].inserted).toBe(false);
  expect((await record('sent', 'email.sent', new Date(Date.now() - 1000))).rows[0].inserted).toBe(true);
  const rows = await auditTransaction(db, 'dawaee_migrator', tx => tx.query('SELECT event_type FROM account_email_delivery_events ORDER BY occurred_at'));
  expect(rows.rows.map(row => row.event_type)).toEqual(['email.sent', 'email.delivered']);
});
it('denies table access and worker execution and rejects invalid statuses', async () => {
  await expect(auditTransaction(db, 'dawaee_app', tx => tx.query('SELECT * FROM account_email_delivery_events'))).rejects.toThrow();
  await expect(auditTransaction(db, 'dawaee_worker', tx => tx.query('SELECT app.record_account_email_delivery($1,$2,$3,now())', ['worker', emailId, 'email.sent']))).rejects.toThrow();
  await expect(record('bad', 'unknown')).rejects.toThrow();
});
it('purges expired operational records without touching accounts or auth challenges', async () => {
  await auditTransaction(db, 'dawaee_migrator', tx => tx.query("UPDATE account_email_delivery_events SET received_at=now()-interval '31 days'"));
  await record('fresh', 'email.delivery_delayed');
  const rows = await auditTransaction(db, 'dawaee_migrator', tx => tx.query('SELECT event_id FROM account_email_delivery_events'));
  expect(rows.rows).toEqual([{ event_id: 'fresh' }]);
});
