import { createHmac, hkdfSync } from 'node:crypto';
import { AppError, ERROR_CODES } from '@dawaee/shared';
import { loadConfig } from '../config.js';
import { withTransaction } from '../lib/db.js';

/**
 * Authentication rate limits that hold across replicas and restarts.
 *
 * The in-process limiter registered in `server.ts` stays where it is — shedding
 * obvious load cheaply is worth doing and does not need to be exact. This is
 * for the handful of limits that exist to stop credential attacks, where an
 * attacker getting N times the budget because the service happens to run N
 * replicas, or a fresh budget because a free-plan instance cold-started, is the
 * difference between a control and the appearance of one.
 *
 * Two things are keyed, and the distinction matters:
 *
 * BY CLIENT ADDRESS, which bounds one source. Useful, but it rests on the
 * proxy chain being what we think it is — see TRUST_PROXY_HOPS — and it is
 * exactly what a distributed attacker sidesteps.
 *
 * BY IDENTIFIER, which bounds attempts against ONE ACCOUNT no matter where they
 * come from. This one holds even if the address is wrong or spoofed, which is
 * why the sign-in path uses both. It is the control that does not depend on
 * resolving how many proxies sit in front of the app.
 */

export type RateScope =
  | 'login:ip' | 'login:identifier'
  | 'register:ip' | 'register:identifier'
  | 'otp-verify:ip' | 'otp-verify:identifier'
  | 'refresh:ip';

export interface Budget {
  windowSeconds: number;
  max: number;
}

/**
 * What each scope allows.
 *
 * The identifier budgets are deliberately tighter than the address budgets: a
 * household or a clinic behind one address may legitimately produce many
 * sign-ins, but nobody legitimately attempts one account twenty times in ten
 * minutes.
 */
export const BUDGETS: Record<RateScope, Budget> = {
  'login:ip': { windowSeconds: 600, max: 30 },
  'login:identifier': { windowSeconds: 600, max: 10 },
  'register:ip': { windowSeconds: 600, max: 10 },
  'register:identifier': { windowSeconds: 3600, max: 5 },
  'otp-verify:ip': { windowSeconds: 600, max: 30 },
  'otp-verify:identifier': { windowSeconds: 600, max: 10 },
  'refresh:ip': { windowSeconds: 600, max: 120 },
};

/**
 * The value that goes into the table, which is never the identifier itself.
 *
 * A table of phone numbers and addresses that recently attempted to sign in is
 * a record of who uses this app, and for a medication app that is a health
 * disclosure. A keyed digest makes the row useless to a reader who does not
 * also hold the application secret, and unlike a plain hash it cannot be
 * reversed by trying every Saudi mobile number — there are only about 10^8 of
 * them, which an unkeyed SHA-256 gives up instantly.
 */
let keyCache: { secret: string; key: Buffer } | null = null;
function budgetKey(scope: RateScope, value: string): string {
  const { JWT_SECRET } = loadConfig();
  if (keyCache?.secret !== JWT_SECRET) {
    keyCache = {
      secret: JWT_SECRET,
      key: Buffer.from(hkdfSync('sha256', Buffer.from(JWT_SECRET, 'utf8'), Buffer.alloc(0), 'dawaee:rate-budget:v1', 32)),
    };
  }
  return createHmac('sha256', keyCache.key).update(`${scope}:${value}`).digest('hex');
}

/**
 * Collapses a client address to the unit a limit should apply to.
 *
 * IPv4 is used whole. Truncating it would lump unrelated people together — a
 * /24 is up to 254 households — and the address is already the smallest unit
 * available.
 *
 * IPv6 is grouped to the first four hextets, its /64. A single residential
 * connection is routinely handed an entire /64, and often far more; keying on
 * the full 128-bit address would let one attacker walk through billions of
 * distinct "clients" without leaving their own line. /64 is the smallest block
 * that is reliably one subscriber rather than one machine.
 *
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is unwrapped first, so the same client
 * reaching the app over either stack lands in one bucket instead of two.
 */
export function clientAddressUnit(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;

  // Expand only as far as needed to take four hextets from the left.
  const [head] = ip.split('%'); // drop any zone index
  const parts = head!.split('::');
  const left = (parts[0] ?? '').split(':').filter(Boolean);
  const right = parts.length > 1 ? (parts[1] ?? '').split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  const full = parts.length > 1
    ? [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right]
    : left;
  return `${full.slice(0, 4).map((h) => h.padStart(4, '0')).join(':')}::/64`;
}

export interface BudgetResult {
  allowed: boolean;
  hits: number;
  retryAfterSeconds: number;
}

/**
 * Count one attempt. Throws 429 when the budget is spent.
 *
 * FAIL CLOSED, on purpose. If this database call fails, the route it guards was
 * going to fail anyway — every one of them needs the same database to look up a
 * credential or write a session. Failing open would mean brute-force protection
 * disappearing at exactly the moment the system is degraded, which is when an
 * attacker is most likely to be the reason it is degraded. The cost of the
 * choice is nil: nobody could have signed in either way.
 *
 * The emergency scan route is deliberately NOT guarded by this. There the
 * trade runs the other way — someone reading a patient's card in an emergency
 * must not be turned away because a database is slow — so it keeps the
 * in-process limiter, which fails open.
 */
export async function consumeBudget(scope: RateScope, value: string): Promise<BudgetResult> {
  const budget = BUDGETS[scope];
  const { rows } = await withTransaction((tx) =>
    tx.query<{ allowed: boolean; hits: number; retry_after_seconds: number }>(
      'SELECT * FROM app.consume_rate_budget($1,$2,$3,$4)',
      [scope, budgetKey(scope, value), budget.windowSeconds, budget.max],
    ));
  const row = rows[0]!;
  return { allowed: row.allowed, hits: row.hits, retryAfterSeconds: row.retry_after_seconds };
}

/**
 * Guards a route. `identifier` is optional because registration by email has no
 * phone and vice versa.
 *
 * The address budget is consumed FIRST and both are always consumed, even when
 * the first one already refused: a caller who is over their address budget
 * should not be able to probe how close an account is to its own limit by
 * watching which of the two answers comes back.
 */
export async function enforceAuthBudget(
  scopes: { ip?: { scope: RateScope; value: string | undefined }; identifier?: { scope: RateScope; value: string } },
): Promise<void> {
  const results: BudgetResult[] = [];
  if (scopes.ip) results.push(await consumeBudget(scopes.ip.scope, clientAddressUnit(scopes.ip.value)));
  if (scopes.identifier) results.push(await consumeBudget(scopes.identifier.scope, scopes.identifier.value));

  const refused = results.find((r) => !r.allowed);
  if (!refused) return;

  // One message for both scopes. Saying WHICH budget was exhausted would tell
  // an attacker whether an identifier is being attacked from elsewhere, and
  // whether their own address is the thing being counted.
  throw new AppError(ERROR_CODES.RATE_LIMITED, 429, 'Too many attempts. Please try again later.', {
    meta: { retryAfterSeconds: refused.retryAfterSeconds },
  });
}

/** Called after a successful sign-in so honest mistakes are not carried. */
export async function clearBudget(scope: RateScope, value: string): Promise<void> {
  await withTransaction((tx) => tx.query('SELECT app.clear_rate_budget($1,$2)', [scope, budgetKey(scope, value)]))
    .catch(() => undefined);
}
