import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES, t, type Locale } from '@dawaee/shared';
import { loadConfig } from '../config.js';
import {
  burnVerificationTime, checkPasswordStrength, hashPassword, needsRehash, verifyPassword,
  MIN_PASSWORD_LENGTH,
} from '../lib/password.js';

/** After this many consecutive failures the account stops answering for a while. */
export const MAX_LOGIN_ATTEMPTS = 8;
export const LOCK_MINUTES = 15;

export type LoginOutcome =
  | { outcome: 'ok'; userId: string; rehashed: boolean }
  | { outcome: 'invalid' }
  | { outcome: 'locked'; until: Date };

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
  const { rows } = await tx.query<LoginRow>(
    'SELECT * FROM app.find_user_for_password_login($1)',
    [identifier],
  );
  const row = rows[0];

  // No account, or an account with no password yet (an OTP-era account that
  // has never set one). Both spend the same time as a real verification so the
  // response cannot be used to discover which phone numbers are registered.
  if (!row || !row.password_hash) {
    await burnVerificationTime();
    return { outcome: 'invalid' };
  }

  /**
   * A locked account is disclosed only to someone who already knows the
   * password.
   *
   * The lock used to be announced to whoever asked: eight wrong guesses turned
   * the ninth response from 401 `invalid_credentials` into 429
   * `account_locked`. Only a real account can be locked, so that was a
   * definitive account-existence oracle costing nine unauthenticated requests —
   * and it charged the victim for the lookup, since the same nine requests lock
   * them out for fifteen minutes. For a medication app, "this number has an
   * account here" is itself a disclosure about someone's health.
   *
   * Verifying the password first splits the two audiences. Someone who cannot
   * supply it gets the same 401 as for a phone number that was never
   * registered, so nothing distinguishes a locked account from a non-existent
   * one. Someone who CAN supply it is the account holder in every practical
   * sense, and telling them "locked for N minutes" is the difference between a
   * clear message and a password that mysteriously stops working.
   *
   * The failure is still recorded while locked. Skipping it would hand an
   * attacker a free guessing window: no counter moves during the lock, so they
   * could spend fifteen minutes guessing and watch for the response to change.
   * Recording pushes `locked_until` further out on every wrong guess instead.
   */
  if (row.locked_until && row.locked_until.getTime() > Date.now()) {
    const correct = await verifyPassword(password, row.password_hash);
    if (!correct) {
      await tx.query('SELECT app.record_login_failure($1,$2,$3)', [row.user_id, MAX_LOGIN_ATTEMPTS, LOCK_MINUTES]);
      return { outcome: 'invalid' };
    }
    // Disabled outranks locked, and is never disclosed either way.
    if (row.disabled) return { outcome: 'invalid' };
    return { outcome: 'locked', until: row.locked_until };
  }

  const ok = await verifyPassword(password, row.password_hash);

  if (!ok) {
    const { rows: lockRows } = await tx.query<{ record_login_failure: Date | null }>(
      'SELECT app.record_login_failure($1,$2,$3) AS record_login_failure',
      [row.user_id, MAX_LOGIN_ATTEMPTS, LOCK_MINUTES],
    );
    const lockedUntil = lockRows[0]?.record_login_failure ?? null;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      return { outcome: 'locked', until: lockedUntil };
    }
    return { outcome: 'invalid' };
  }

  // A disabled account is refused only AFTER the password checked out, so the
  // refusal cannot be used to enumerate which accounts exist.
  if (row.disabled) return { outcome: 'invalid' };

  await tx.query('SELECT app.clear_login_failures($1)', [row.user_id]);

  let rehashed = false;
  if (needsRehash(row.password_hash)) {
    await tx.query('SELECT app.set_password($1,$2)', [row.user_id, await hashPassword(password)]);
    rehashed = true;
  }

  return { outcome: 'ok', userId: row.user_id, rehashed };
}

/** Call only after the transaction has committed. */
export function assertLogin(result: LoginOutcome, locale: Locale): asserts result is Extract<LoginOutcome, { outcome: 'ok' }> {
  if (result.outcome === 'ok') return;

  if (result.outcome === 'locked') {
    const minutes = Math.max(1, Math.ceil((result.until.getTime() - Date.now()) / 60_000));
    throw new AppError(
      ERROR_CODES.ACCOUNT_LOCKED, 429,
      t(locale, 'auth.accountLocked', { minutes: String(minutes) }),
    );
  }

  // One message for a wrong identifier and a wrong password alike. Telling them
  // apart would reveal whether a given person has an account here, and for a
  // medication app that is itself a disclosure about their health.
  throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 401, t(locale, 'auth.invalidCredentials'));
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
