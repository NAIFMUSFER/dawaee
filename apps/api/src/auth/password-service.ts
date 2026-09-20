import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES, t, type Locale } from '@dawaee/shared';
import { loadConfig } from '../config.js';
import {
  burnVerificationTime, checkPasswordStrength, hashPassword, needsRehash, verifyPassword,
  MIN_PASSWORD_LENGTH,
} from '../lib/password.js';
import { clearBudgetInTransaction } from './rate-budget.js';

/** After this many consecutive failures the account stops answering for a while. */
export const MAX_LOGIN_ATTEMPTS = 8;
export const LOCK_MINUTES = 15;

export type LoginOutcome =
  | { outcome: 'ok'; userId: string; rehashed: boolean; credentialHash: string }
  | { outcome: 'invalid' };

interface LoginRow {
  user_id: string;
  password_hash: string | null;
  locked_until: Date | null;
  failed_login_count: number;
  disabled: boolean;
}

/**
 * Attempts a password sign-in and RETURNS the outcome instead of throwing.
 *
 * This shape is not stylistic. The failure counter is written inside this
 * transaction, and a `throw` here would roll it back together with the very
 * record of the attempt — turning the lockout into an unlimited guessing
 * budget. The caller commits, then calls `assertLogin` on the result. The same
 * mistake has already been found twice in this codebase, in the OTP path and in
 * refresh-token rotation; the pattern exists so it is not made a third time.
 */
export async function attemptPasswordLogin(
  tx: PoolClient,
  identifier: string,
  password: string,
): Promise<LoginOutcome> {
  let { rows } = await tx.query<LoginRow>(
    'SELECT * FROM app.find_user_for_password_login($1)',
    [identifier],
  );
  if (rows[0]) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20260912))', [rows[0].user_id]);
    ({ rows } = await tx.query<LoginRow>('SELECT * FROM app.find_user_for_password_login($1)', [identifier]));
  }
  const row = rows[0];

  // No account, or an account with no password yet (an OTP-era account that
  // has never set one). Both spend the same time as a real verification so the
  // response cannot be used to discover which phone numbers are registered.
  if (!row || !row.password_hash) {
    await burnVerificationTime();
    return { outcome: 'invalid' };
  }

  // Do not verify a candidate against the real credential during a lock.
  // Returning account_locked only for a correct guess was a password oracle:
  // an attacker could keep testing guesses even though no session was issued.
  // Use the same decoy work as an unknown account, record every refused attempt
  // without branching on the password, and keep the original lock deadline.
  // The public refusal includes generic retry/recovery advice for everybody;
  // neither the existence of a lock nor its deadline is disclosed.
  if (row.locked_until && row.locked_until.getTime() > Date.now()) {
    await burnVerificationTime();
    await tx.query('SELECT app.record_login_failure($1,$2,$3)', [row.user_id, MAX_LOGIN_ATTEMPTS, LOCK_MINUTES]);
    return { outcome: 'invalid' };
  }

  const ok = await verifyPassword(password, row.password_hash);

  if (!ok) {
    await tx.query(
      'SELECT app.record_login_failure($1,$2,$3) AS record_login_failure',
      [row.user_id, MAX_LOGIN_ATTEMPTS, LOCK_MINUTES],
    );
    // The attempt that starts a lock must be indistinguishable from every
    // other refused sign-in, including correct guesses during a lock.
    return { outcome: 'invalid' };
  }

  // A disabled account is refused only AFTER the password checked out, so the
  // refusal cannot be used to enumerate which accounts exist.
  if (row.disabled) return { outcome: 'invalid' };

  await tx.query('SELECT app.clear_login_failures($1)', [row.user_id]);

  let rehashed = false;
  let credentialHash = row.password_hash;
  if (needsRehash(row.password_hash)) {
    credentialHash = await hashPassword(password);
    await tx.query('SELECT app.set_password($1,$2)', [row.user_id, credentialHash]);
    rehashed = true;
  }

  return { outcome: 'ok', userId: row.user_id, rehashed, credentialHash };
}

/** Call only after the transaction has committed. */
export function assertLogin(result: LoginOutcome, locale: Locale): asserts result is Extract<LoginOutcome, { outcome: 'ok' }> {
  if (result.outcome === 'ok') return;

  // One message for unknown, wrong, disabled, passwordless and locked accounts.
  throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 401, t(locale, 'auth.signInRefused', { minutes: String(LOCK_MINUTES) }));
}

/**
 * A completed recovery must be an actual way out of account-targeted denial.
 *
 * Password recovery already proves the current mailbox or phone and resets the
 * credential/account lock. Clear every current login spelling in that SAME
 * transaction so a previously exhausted pre-password identifier bucket cannot
 * immediately strand the owner behind a 429. The caller may supply only the
 * user id returned by the SECURITY DEFINER recovery function; setting the RLS
 * identity here then reveals only that recovered account's own identifiers.
 *
 * Keeping this in the recovery transaction matters: a 200 response now means
 * the new password and the escape from the stored denial committed together.
 * Invalid, expired, unknown and disabled recovery attempts never call it.
 */
export async function clearRecoveredLoginBudgets(tx: PoolClient, userId: string): Promise<void> {
  await tx.query("SELECT set_config('app.user_id',$1,true)", [userId]);
  const { rows } = await tx.query<{ phone_e164: string | null; email: string | null }>(
    'SELECT phone_e164,email FROM users WHERE id=$1', [userId],
  );
  const account = rows[0];
  if (!account) throw new Error('Recovered account is no longer readable');

  const identifiers = new Set<string>();
  if (account.phone_e164) identifiers.add(account.phone_e164);
  if (account.email) identifiers.add(account.email.trim().toLowerCase());
  for (const identifier of identifiers) {
    await clearBudgetInTransaction(tx, 'login:identifier', identifier);
  }
}

/** Validates a new password and returns its hash, or throws a localized reason. */
export async function hashNewPassword(
  password: string,
  locale: Locale,
  identifier?: string,
): Promise<string> {
  const problem = checkPasswordStrength(password, identifier);
  if (problem) {
    const key = {
      too_short: 'auth.passwordTooShort',
      too_long: 'auth.passwordTooLong',
      too_common: 'auth.passwordTooCommon',
      same_as_identifier: 'auth.passwordSameAsIdentifier',
    }[problem.reason] as Parameters<typeof t>[1];

    throw new AppError(
      ERROR_CODES.WEAK_PASSWORD, 400,
      t(locale, key, { min: String(MIN_PASSWORD_LENGTH) }),
    );
  }
  return hashPassword(password);
}

export function passwordLoginEnabled(): boolean {
  return loadConfig().PASSWORD_LOGIN_ENABLED;
}
