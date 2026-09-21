import { afterEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/lib/db.js', () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({ query: io.query }) }));
import { AccountEmailDeliveryError, drainAccountEmails, sealEmailJob } from '../src/providers/account-email.js';

afterEach(() => vi.resetAllMocks());
it('reports safe categories, continues past bad jobs, and preserves failed leases for retry', async () => {
  const mail = { email: 'private@example.com', token: 'x'.repeat(43), purpose: 'reset' as const, locale: 'ar' as const };
  const payload = await sealEmailJob(mail);
  io.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('claim_account_emails')
    ? [{ token_hash: 'bad-payload', payload: 'private malformed ciphertext' },
      { token_hash: 'provider-failure', payload }, { token_hash: 'success', payload }]
    : sql.includes('claim_registration_emails') ? [{ token_hash: 'registration-failure', payload }] : [] }));
  const send = vi.fn().mockRejectedValueOnce(new AccountEmailDeliveryError('rate_limited'))
    .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private provider content'));
  const diagnose = vi.fn();
  expect(await drainAccountEmails(send, diagnose)).toBe(1);
  expect(diagnose.mock.calls).toEqual([
    [{ queue: 'account', code: 'invalid_payload' }],
    [{ queue: 'account', code: 'rate_limited' }],
    [{ queue: 'registration', code: 'unknown' }],
  ]);
  expect(send.mock.calls.map(call => call[1])).toEqual(['provider-failure', 'success', 'registration-failure']);
  const finishes = io.query.mock.calls.filter(([sql]) => sql.includes('finish_'));
  expect(finishes.map(([, args]) => [args[0], args[2]])).toEqual([
    ['bad-payload', false], ['provider-failure', false], ['success', true], ['registration-failure', false],
  ]);
  expect(finishes[0]![1][1]).toBe(finishes[2]![1][1]);
  expect(JSON.stringify(diagnose.mock.calls)).not.toContain(mail.email);
  expect(JSON.stringify(diagnose.mock.calls)).not.toContain(mail.token);
});
it('still finishes the lease when a diagnostic observer throws', async () => {
  io.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('claim_account_emails')
    ? [{ token_hash: 'key', payload: 'malformed' }] : [] }));
  await expect(drainAccountEmails(vi.fn(), () => { throw new Error('observer failed'); })).resolves.toBe(0);
  expect(io.query.mock.calls.some(([sql, args]) => sql.includes('finish_account_email') && args[2] === false)).toBe(true);
});
