import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';

/**
 * The TLS policy for every database connection this system makes.
 *
 * One function, used by both the API and the worker, because the previous
 * arrangement was two copies of the same ternary in two files — and two copies
 * of a security decision is how one of them ends up different from the other
 * without anybody noticing.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────
 *
 * `render.yaml` set `DATABASE_SSL: "no-verify"` for both services, which
 * produced `{ rejectUnauthorized: false }`. That is not "TLS with a minor
 * caveat": it accepts ANY certificate, from anyone. The connection is
 * encrypted against a passive eavesdropper and completely open to an active
 * one — anything positioned between Render's Frankfurt region and Supabase's
 * eu-central-1 that can answer for the pooler's address presents a
 * self-signed certificate, gets accepted, and reads and rewrites every query
 * in a database of medication records. It also holds the database owner's
 * password, because the connection string carries it.
 *
 * ── THE MODEL ─────────────────────────────────────────────────────────────
 *
 * `DATABASE_SSL` selects the policy:
 *
 *   'true'      TLS with full verification. `rejectUnauthorized: true`, always.
 *               The trust anchor is the operator-supplied CA when one is
 *               configured, and the system trust store otherwise.
 *   'no-verify' TLS with NO verification. Permitted only outside production,
 *               for a local container with a self-signed certificate. In
 *               production it is a boot failure, not a warning.
 *   'false'     No TLS at all. Local development only; also a boot failure in
 *               production.
 *
 * There is deliberately no mode that verifies "a bit". A production process
 * either verifies the peer or refuses to start.
 *
 * ── WHY A CA MAY BE REQUIRED ──────────────────────────────────────────────
 *
 * Supabase documents that connecting with `sslmode=verify-full` requires
 * downloading their CA certificate from the project dashboard (Database
 * Settings ▸ SSL Configuration, `prod-ca-2021.crt`), and their own psql
 * example passes it as `sslrootcert`. So the Postgres endpoint is NOT assumed
 * to chain to a publicly trusted root: if it does not, verification against
 * the system store fails and the service refuses to start — loudly, at boot,
 * with a message naming the variable to set.
 *
 * No certificate is invented, embedded or guessed here. The operator downloads
 * theirs and supplies it. That is the only honest option: a CA bundle
 * committed to a repository is a trust anchor nobody is rotating.
 */

export interface DatabaseTls {
  rejectUnauthorized: boolean;
  ca?: string;
}

/** Raised at boot. Never carries certificate or credential material. */
export class DatabaseTlsMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseTlsMisconfigured';
  }
}

const PEM_BEGIN = '-----BEGIN CERTIFICATE-----';
const PEM_END = '-----END CERTIFICATE-----';

/**
 * Load the operator's CA, from an inline PEM or a file path.
 *
 * Inline first, because Render and most platforms hold multi-line secrets as
 * environment variables and mounting a file is the awkward path. `\n` written
 * literally is accepted, since a value pasted into a single-line settings field
 * arrives that way and the failure it otherwise causes ("unable to get local
 * issuer certificate") points nowhere near the real cause.
 */
function loadCa(cfg: Config): string | undefined {
  const inline = cfg.DATABASE_CA_CERT?.trim();
  const path = cfg.DATABASE_CA_CERT_FILE?.trim();

  if (inline && path) {
    throw new DatabaseTlsMisconfigured(
      'Set DATABASE_CA_CERT or DATABASE_CA_CERT_FILE, not both',
    );
  }

  let pem: string | undefined;
  if (inline) {
    pem = inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
  } else if (path) {
    try {
      pem = readFileSync(path, 'utf8');
    } catch {
      // The path, not the contents. A missing file is an operator mistake worth
      // naming; its bytes are not.
      throw new DatabaseTlsMisconfigured(`DATABASE_CA_CERT_FILE could not be read: ${path}`);
    }
  }
  if (pem === undefined) return undefined;

  // Validated here rather than discovered on the first query. A truncated paste
  // — the common failure, because these are long and get clipped — otherwise
  // surfaces as a connection error at an arbitrary later moment.
  const begins = pem.split(PEM_BEGIN).length - 1;
  const ends = pem.split(PEM_END).length - 1;
  if (begins === 0 || ends === 0 || begins !== ends) {
    throw new DatabaseTlsMisconfigured(
      'The configured database CA is not valid PEM (expected matching BEGIN/END CERTIFICATE blocks)',
    );
  }
  return pem;
}

/**
 * The `ssl` option for a `pg.Pool`, or false for no TLS.
 *
 * Throws rather than degrading. A process that cannot establish what its trust
 * anchor is must not start and then connect anyway.
 */
export function databaseTlsOptions(cfg: Config): DatabaseTls | false {
  const isProduction = cfg.NODE_ENV === 'production';

  if (isProduction && cfg.DATABASE_SSL !== 'true') {
    throw new DatabaseTlsMisconfigured(
      `DATABASE_SSL must be "true" in production (got "${cfg.DATABASE_SSL}"). ` +
      'Certificate verification cannot be disabled for a production database.',
    );
  }

  if (cfg.DATABASE_SSL === 'false') return false;

  if (cfg.DATABASE_SSL === 'no-verify') {
    // Unreachable in production — the guard above already threw. Kept for a
    // local Postgres container presenting a self-signed certificate.
    return { rejectUnauthorized: false };
  }

  const ca = loadCa(cfg);
  return ca === undefined
    ? { rejectUnauthorized: true }
    : { rejectUnauthorized: true, ca };
}

/**
 * A one-line description for the startup log.
 *
 * Deliberately says which trust anchor is in use, because "TLS is on" was
 * exactly the belief that made `no-verify` survive in production for as long
 * as it did. Contains no certificate material.
 */
export function describeDatabaseTls(cfg: Config): string {
  const tls = databaseTlsOptions(cfg);
  if (tls === false) return 'database TLS: disabled (development only)';
  if (!tls.rejectUnauthorized) return 'database TLS: encrypted but UNVERIFIED (development only)';
  return tls.ca
    ? 'database TLS: verified against the operator-supplied CA'
    : 'database TLS: verified against the system trust store';
}
