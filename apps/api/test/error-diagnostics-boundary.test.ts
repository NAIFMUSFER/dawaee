import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeLoggedError } from '@dawaee/shared';
import { createLogger } from '../src/lib/logger.js';
import { closePool, getPool } from '../src/lib/db.js';
import { createWorkerLogger } from '../../worker/src/context.js';
import { loadConfig } from '../src/config.js';
import { logStartupFailure } from '../src/lib/startup-diagnostics.js';
import { SchemaContractError } from '../src/lib/schema-contract.js';
import { DatabaseTlsMisconfigured } from '../src/lib/db-tls.js';

const CANARY = 'patient free text Zoprexa symptom private';

describe('N1 free-text errors cannot escape through diagnostics', () => {
  afterEach(async () => { vi.restoreAllMocks(); await closePool(); });

  it('discards driver messages, stack, row metadata and custom fields but keeps SQLSTATE', () => {
    const err = Object.assign(new Error(CANARY), {
      code: '23505', detail: CANARY, hint: CANARY, query: CANARY,
      table: CANARY, constraint: CANARY, schema: CANARY, routine: CANARY,
    });
    const result = serializeLoggedError(err);
    expect(result).toMatchObject({ type: 'Error', code: '23505' });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result).not.toHaveProperty('message');
    expect(result).not.toHaveProperty('stack');
  });

  it('does not stringify thrown strings or arbitrary objects', () => {
    expect(serializeLoggedError(CANARY)).toEqual({ type: 'string' });
    const toString = vi.fn(() => CANARY);
    expect(serializeLoggedError({ message: CANARY, toString })).toEqual({ type: 'object' });
    expect(toString).not.toHaveBeenCalled();
    expect(serializeLoggedError(null)).toEqual({ type: 'null' });
  });

  it('retains allowlisted system codes but not arbitrary names or codes', () => {
    const err = Object.assign(new TypeError(CANARY), { code: 'ECONNRESET' });
    expect(serializeLoggedError(err)).toMatchObject({ type: 'TypeError', code: 'ECONNRESET' });
    err.name = CANARY;
    err.code = CANARY;
    expect(JSON.stringify(serializeLoggedError(err))).not.toContain(CANARY);
  });

  it('bounds cyclic causes and never emits their text', () => {
    const err = new Error(CANARY);
    err.cause = err;
    const result = JSON.stringify(serializeLoggedError(err));
    expect(result).not.toContain(CANARY);
    expect(result.length).toBeLessThan(500);
  });

  it('protects the real pool idle-error callback before a logger exists', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getPool().emit('error', Object.assign(new Error(CANARY), { code: '08006' }));
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.stringify(write.mock.calls)).not.toContain(CANARY);
    expect(JSON.stringify(write.mock.calls)).toContain('08006');
    expect(JSON.stringify(write.mock.calls)).toContain('idle postgres client error');
  });

  it('preserves startup schema diagnostics using only migration names in this build', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = new SchemaContractError(['0020_notification_privacy.sql', CANARY], [CANARY]);
    err.message = CANARY;
    logStartupFailure(err);
    const output = JSON.stringify(write.mock.calls);
    expect(output).not.toContain(CANARY);
    expect(output).toContain('0020_notification_privacy.sql');
    expect(output).toContain('schema is incompatible');
    expect(output).toContain('run scripts/migrate.sh');
  });

  it('identifies a TLS startup refusal without quoting a certificate path or message', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logStartupFailure(new DatabaseTlsMisconfigured(CANARY));
    expect(JSON.stringify(write.mock.calls)).not.toContain(CANARY);
    expect(JSON.stringify(write.mock.calls)).toContain('certificate verification');
  });

  it('protects both actual logger factories, including worker tick error shape', () => {
    let written = '';
    const stream = new Writable({ write(chunk, _encoding, done) { written += String(chunk); done(); } });
    const worker = createWorkerLogger({ ...loadConfig(), LOG_LEVEL: 'error' }, stream);
    worker.error({ err: Object.assign(new Error(CANARY), { code: 'ETIMEDOUT' }) }, 'tick failed');
    expect(written).not.toContain(CANARY);
    expect(written).toContain('ETIMEDOUT');
    // Pino exposes the installed serializer; use the real API factory instead
    // of a test-only reconstruction of its configuration.
    const api = createLogger() as unknown as { [key: symbol]: Record<string, (err: unknown) => unknown> };
    const serializers = api[Symbol.for('pino.serializers')];
    expect(JSON.stringify(serializers!.err!(new Error(CANARY)))).not.toContain(CANARY);
  });
});
