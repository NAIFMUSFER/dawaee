import type { Queryable } from '../lib/db.js';
import { consumeBudgetInTransaction } from './rate-budget.js';

/** Reserve provider capacity only for a newly queued job, in its transaction. */
export async function enqueueAccountEmail<T>(
  tx: Queryable,
  tokenHash: string,
  enqueue: () => Promise<T>,
): Promise<{ result: T; limited: boolean; retryAfterSeconds: number }> {
  // A refused replacement must leave the previous usable link intact. The
  // independent IP/recipient attempt budgets have already committed upstream.
  await tx.query('SAVEPOINT account_email_capacity');
  const result = await enqueue();
  const { rows } = await tx.query<{ pending: boolean }>(
    'SELECT app.account_email_job_pending($1) AS pending', [tokenHash],
  );
  if (typeof rows[0]?.pending !== 'boolean') throw new Error('Invalid email capacity result');
  if (rows[0].pending) {
    const budget = await consumeBudgetInTransaction(tx, 'email:global', 'account-email');
    if (!budget.allowed) {
      await tx.query('ROLLBACK TO SAVEPOINT account_email_capacity');
      await tx.query('RELEASE SAVEPOINT account_email_capacity');
      return { result, limited: true, retryAfterSeconds: budget.retryAfterSeconds };
    }
  }
  await tx.query('RELEASE SAVEPOINT account_email_capacity');
  return { result, limited: false, retryAfterSeconds: 0 };
}
