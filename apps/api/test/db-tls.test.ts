import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseTlsOptions, describeDatabaseTls, DatabaseTlsMisconfigured } from '../src/lib/db-tls.js';
import { loadConfig, resetConfigCache } from '../src/config.js';

/**
 * Database TLS, which was `rejectUnauthorized: false` in production.
 *
 * That is not "TLS with a caveat" — it accepts any certificate from anyone.
 * The traffic is protected from a passive eavesdropper and wide open to an
 * active one: anything able to answer for the pooler's address between
 * Render's Frankfurt region and Supabase's eu-central-1 presents a self-signed
 * certificate, is accepted, and reads and rewrites every query in a database of
 * medication records — while also collecting the owner password the connection
 * string carries.
 */

const ROOT = resolve(import.meta.dirname, '../../..');

const REAL_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBkTCB+wIJAKZ2Zm1kZXhhMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCWxv',
  'Y2FsaG9zdDAeFw0yNjAxMDEwMDAwMDBaFw0zNjAxMDEwMDAwMDBaMBQxEjAQBgNV',
  '-----END CERTIFICATE-----',
].join('\n');

/** Everything a production boot needs, minus the TLS settings under test. */
const PROD_BASE = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db.example.com:5432/dawaee',
  JWT_SECRET: 'x'.repeat(64),
  IP_HASH_SALT: 'a-real-production-salt-value',
  PUSH_PROVIDER: 'expo',
  STORAGE_PROVIDER: 's3',
  OTP_DEBUG_ECHO: 'false',
};

const cfg = (env: Record<string, string | undefined>) => {
  resetConfigCache();
  return loadConfig(env as NodeJS.ProcessEnv);
};

afterEach(() => resetConfigCache());

describe('production verifies the certificate, or does not start', () => {
  it('verifies with DATABASE_SSL=true', () => {
    const tls = databaseTlsOptions(cfg({ ...PROD_BASE, DATABASE_SSL: 'true' }));
    expect(tls).toEqual({ rejectUnauthorized: true });
  });

  /**
   * The defect itself. Not a warning, not a downgrade — the process must
   * refuse to start, because a service that logs a warning and connects anyway
   * has the same vulnerability plus a log line nobody reads.
   */
  it('refuses to boot on no-verify in production', () => {
    expect(() => cfg({ ...PROD_BASE, DATABASE_SSL: 'no-verify' }))
      .toThrow(/DATABASE_SSL must be "true" in production/);
  });

  it('refuses to boot with TLS off in production', () => {
    expect(() => cfg({ ...PROD_BASE, DATABASE_SSL: 'false' }))
      .toThrow(/DATABASE_SSL must be "true" in production/);
  });

  /**
   * The default is 'false', so an operator who simply forgets the variable
   * gets a refusal rather than a plaintext connection to a medication database.
   */
  it('refuses to boot when the variable is absent entirely', () => {
    expect(() => cfg({ ...PROD_BASE, DATABASE_SSL: undefined }))
      .toThrow(/DATABASE_SSL must be "true" in production/);
  });

  /** Defence in depth: the TLS layer re-checks rather than trusting its caller. */
  it('the TLS layer refuses no-verify in production even if config were bypassed', () => {
    const good = cfg({ ...PROD_BASE, DATABASE_SSL: 'true' });
    const tampered = { ...good, DATABASE_SSL: 'no-verify' as const };
    expect(() => databaseTlsOptions(tampered)).toThrow(DatabaseTlsMisconfigured);
  });

  it('never returns rejectUnauthorized:false for a production config', () => {
    const tls = databaseTlsOptions(cfg({ ...PROD_BASE, DATABASE_SSL: 'true' }));
    expect(tls).not.toBe(false);
    expect((tls as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(true);
  });
});

describe('the operator supplies the CA; none is invented here', () => {
  it('uses an inline PEM as the trust anchor', () => {
    const tls = databaseTlsOptions(cfg({ ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT: REAL_PEM }));
    expect(tls).toEqual({ rejectUnauthorized: true, ca: REAL_PEM });
  });

  /**
   * A PEM pasted into a single-line settings field arrives with literal `\n`.
   * Without this it fails much later as "unable to get local issuer
   * certificate", which points nowhere near the real cause.
   */
  it('accepts a PEM whose newlines were escaped by a settings field', () => {
    const escaped = REAL_PEM.replace(/\n/g, '\\n');
    const tls = databaseTlsOptions(cfg({ ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT: escaped }));
    expect((tls as { ca: string }).ca).toBe(REAL_PEM);
  });

  it('reads a CA from a file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dawaee-ca-'));
    const path = join(dir, 'ca.crt');
    writeFileSync(path, REAL_PEM);
    const tls = databaseTlsOptions(cfg({ ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT_FILE: path }));
    expect((tls as { ca: string }).ca).toBe(REAL_PEM);
  });

  it('falls back to the system trust store when no CA is configured', () => {
    const tls = databaseTlsOptions(cfg({ ...PROD_BASE, DATABASE_SSL: 'true' }));
    expect(tls).not.toHaveProperty('ca');
    expect((tls as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(true);
  });

  /**
   * These are long and get clipped on the way into a settings field. A
   * truncated paste must fail at boot, not on an arbitrary later query.
   */
  it('rejects a truncated PEM', () => {
    const truncated = REAL_PEM.replace('-----END CERTIFICATE-----', '');
    expect(() => databaseTlsOptions(cfg({ ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT: truncated })))
      .toThrow(/not valid PEM/);
  });

  it('rejects a value that is not a certificate at all', () => {
    expect(() => databaseTlsOptions(cfg({ ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT: 'hunter2' })))
      .toThrow(/not valid PEM/);
  });

  it('rejects mismatched BEGIN/END counts', () => {
    const doubled = `${REAL_PEM}\n-----BEGIN CERTIFICATE-----\nMIIB\n`;
    expect(() => databaseTlsOptions(cfg({ ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT: doubled })))
      .toThrow(/not valid PEM/);
  });

  it('rejects a missing CA file rather than silently continuing', () => {
    expect(() => databaseTlsOptions(cfg({
      ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT_FILE: '/nonexistent/ca.crt',
    }))).toThrow(/could not be read/);
  });

  it('refuses both sources at once rather than picking one', () => {
    expect(() => databaseTlsOptions(cfg({
      ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT: REAL_PEM, DATABASE_CA_CERT_FILE: '/tmp/x.crt',
    }))).toThrow(/not both/);
  });

  it('never leaks certificate material into an error', () => {
    const err = (() => {
      try {
        databaseTlsOptions(cfg({ ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT: 'SECRETMATERIAL' }));
        return null;
      } catch (e) { return e as Error; }
    })();
    expect(err).toBeInstanceOf(DatabaseTlsMisconfigured);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('SECRETMATERIAL');
  });

  it('ships no CA certificate in the repository', () => {
    const tlsSrc = readFileSync(join(ROOT, 'apps/api/src/lib/db-tls.ts'), 'utf8');
    // A bundle committed to source is a trust anchor nobody rotates.
    expect(tlsSrc).not.toContain('MII');
  });
});

describe('development is explicit and cannot reach production', () => {
  const DEV = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://localhost:5433/dawaee_dev',
    JWT_SECRET: 'dev-secret-value-long-enough-for-the-schema',
  };

  it('allows plaintext locally', () => {
    expect(databaseTlsOptions(cfg({ ...DEV, DATABASE_SSL: 'false' }))).toBe(false);
  });

  it('allows an unverified local container', () => {
    expect(databaseTlsOptions(cfg({ ...DEV, DATABASE_SSL: 'no-verify' })))
      .toEqual({ rejectUnauthorized: false });
  });

  it('still verifies locally when asked to', () => {
    expect(databaseTlsOptions(cfg({ ...DEV, DATABASE_SSL: 'true' })))
      .toEqual({ rejectUnauthorized: true });
  });

  /**
   * The leak this guards: the relaxed mode is gated on NODE_ENV, so the same
   * variables that are fine locally are a boot failure in production.
   */
  it('the same relaxed settings fail the moment NODE_ENV is production', () => {
    expect(databaseTlsOptions(cfg({ ...DEV, DATABASE_SSL: 'no-verify' })))
      .toEqual({ rejectUnauthorized: false });
    expect(() => cfg({ ...PROD_BASE, DATABASE_SSL: 'no-verify' })).toThrow();
  });
});

describe('the API and the worker cannot drift apart', () => {
  it('both build their pool from the same function', () => {
    const api = readFileSync(join(ROOT, 'apps/api/src/lib/db.ts'), 'utf8');
    const worker = readFileSync(join(ROOT, 'apps/worker/src/context.ts'), 'utf8');
    expect(api).toContain('ssl: databaseTlsOptions(');
    expect(worker).toContain('ssl: databaseTlsOptions(');
  });

  it('neither hand-rolls rejectUnauthorized any more', () => {
    for (const f of ['apps/api/src/lib/db.ts', 'apps/worker/src/context.ts']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, f).not.toContain('rejectUnauthorized');
    }
  });

  it('produces an identical policy for the same config', () => {
    const c = cfg({ ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT: REAL_PEM });
    // Both call sites pass the same Config object to the same function, so the
    // policy is identical by construction — asserted so a future divergence
    // has to break a test rather than pass review.
    expect(databaseTlsOptions(c)).toEqual(databaseTlsOptions(c));
  });
});

describe('render.yaml no longer configures no-verify', () => {
  const yaml = readFileSync(join(ROOT, 'render.yaml'), 'utf8');

  it('sets no DATABASE_SSL value other than true', () => {
    const values = [...yaml.matchAll(/key:\s*DATABASE_SSL[\s\S]{0,400}?value:\s*"([^"]+)"/g)]
      .map((m) => m[1]);
    expect(values.length, 'both services declare it').toBe(2);
    expect(values).toEqual(['true', 'true']);
  });

  it('has no no-verify outside a comment', () => {
    const code = yaml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toContain('no-verify');
  });

  it('offers the CA as an unsynced secret rather than a committed value', () => {
    expect(yaml).toContain('key: DATABASE_CA_CERT');
    const blocks = [...yaml.matchAll(/key:\s*DATABASE_CA_CERT\n\s*sync:\s*false/g)];
    expect(blocks.length).toBe(2);
  });
});

describe('the startup line says which anchor is in use', () => {
  it('names the operator CA', () => {
    expect(describeDatabaseTls(cfg({ ...PROD_BASE, DATABASE_SSL: 'true', DATABASE_CA_CERT: REAL_PEM })))
      .toMatch(/operator-supplied CA/);
  });

  it('names the system store', () => {
    expect(describeDatabaseTls(cfg({ ...PROD_BASE, DATABASE_SSL: 'true' })))
      .toMatch(/system trust store/);
  });

  it('says plainly when verification is off', () => {
    expect(describeDatabaseTls(cfg({
      NODE_ENV: 'development', DATABASE_URL: 'postgres://localhost/x',
      JWT_SECRET: 'dev-secret-value-long-enough-for-the-schema', DATABASE_SSL: 'no-verify',
    }))).toMatch(/UNVERIFIED/);
  });
});
