import { execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import pino from 'pino';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOG_REDACTION, serializeLoggedError } from '@dawaee/shared';
import { redactUrl } from '../src/lib/logger.js';
import { createWorkerLogger } from '../../worker/src/context.js';
import { loadConfig } from '../src/config.js';
import { resetDatabase, startHarness, signIn, type Harness, type TestUser } from './harness.js';

/**
 * P13 — what actually reaches the log.
 *
 * The brief's observability rule is short: never unnecessarily log medication
 * names or health data, and never log OTP, password or token values. The
 * redaction config is written to satisfy it. The question this file asks is
 * the different one — not "is the config right" but "is what pino writes to
 * stdout free of the things the config is meant to keep out", which is the
 * only version an aggregator cares about.
 *
 * So every assertion here reads a real log line captured from a real pino
 * instance, built by the real factory, over payloads shaped like the ones the
 * application actually passes. Two of the three findings this replaced were
 * invisible from the config alone: `err.detail` is a property of a serialized
 * error rather than a path redaction walks, and `note.text` is the shape the
 * dose-confirmation contract uses while the config named `notes`.
 */

/** Captures whatever a logger writes, as parsed lines. */
function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); },
  });
  return {
    stream,
    text: () => lines.join(''),
    objects: () => lines.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** The API's logger, wired to a capture stream instead of fd 1. */
function apiLogger(sink: Writable) {
  return pino({
    level: 'trace',
    redact: LOG_REDACTION,
    base: { service: 'dawaee-api', env: 'test' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: serializeLoggedError,
      req(req: { method?: string; url?: string; headers?: Record<string, unknown>; ip?: string }) {
        return { method: req.method, url: redactUrl(req.url ?? ''), host: req.headers?.host, remoteAddress: req.ip };
      },
    },
  }, sink);
}

/**
 * The worker's ACTUAL logger, via the worker's own factory.
 *
 * Not a reconstruction. An earlier version of this file built a second pino
 * instance from `LOG_REDACTION` directly and called it "the worker logger" —
 * which tested the shared policy twice and the worker's wiring not at all.
 * Reverting the worker to its old drifted list failed nothing. This calls
 * `createWorkerLogger`, so that revert now fails here.
 */
function workerLogger(sink: Writable) {
  return createWorkerLogger({ ...loadConfig(), LOG_LEVEL: 'trace' }, sink);
}

/**
 * Everything a log line must never contain, with a payload that would put it
 * there. The values are distinctive so a match cannot be a coincidence.
 */
const SECRETS: Array<{ what: string; value: string; payload: () => Record<string, unknown> }> = [
  { what: 'a medication name', value: 'Zoprexa-Probe', payload: () => ({ medication: 'Zoprexa-Probe' }) },
  { what: 'a medication name nested', value: 'Zoprexa-Probe', payload: () => ({ delivery: { medicationName: 'Zoprexa-Probe' } }) },
  { what: 'a phone number', value: '+966500777111', payload: () => ({ phone: '+966500777111' }) },
  { what: 'a recipient phone', value: '+966500777112', payload: () => ({ to: '+966500777112' }) },
  { what: 'an invited phone', value: '+966500777113', payload: () => ({ invitedPhone: '+966500777113' }) },
  { what: 'an allergy list', value: 'probe-penicillin', payload: () => ({ allergies: ['probe-penicillin'] }) },
  { what: 'a conditions note', value: 'probe-condition-text', payload: () => ({ conditionsNote: 'probe-condition-text' }) },
  { what: 'symptom free text', value: 'probe-felt-dizzy', payload: () => ({ note: { tags: ['dizziness'], text: 'probe-felt-dizzy' } }) },
  { what: 'symptom free text in a body', value: 'probe-felt-sick', payload: () => ({ req: { body: { note: { text: 'probe-felt-sick' } } } }) },
  { what: 'an OTP code', value: '918273', payload: () => ({ req: { body: { code: '918273' } } }) },
  { what: 'a refresh token', value: 'probe-refresh-token-value', payload: () => ({ req: { body: { refreshToken: 'probe-refresh-token-value' } } }) },
  { what: 'an authorization header', value: 'Bearer probe-access-token', payload: () => ({ req: { headers: { authorization: 'Bearer probe-access-token' } } }) },
];

describe('P13-1 neither logger writes what the policy forbids', () => {
  it('the API logger redacts every one of them', () => {
    const sink = capture();
    const log = apiLogger(sink.stream);
    for (const s of SECRETS) log.info(s.payload(), 'probe');
    const text = sink.text();
    const leaked = SECRETS.filter((s) => text.includes(s.value)).map((s) => s.what);
    expect(leaked, 'the API log carried these').toEqual([]);
  });

  it('the worker logger redacts every one of them too', () => {
    const sink = capture();
    const log = workerLogger(sink.stream);
    for (const s of SECRETS) log.info(s.payload(), 'probe');
    const text = sink.text();
    const leaked = SECRETS.filter((s) => text.includes(s.value)).map((s) => s.what);
    expect(leaked, 'the worker log carried these').toEqual([]);
  });

  /**
   * The point of moving the policy into `@dawaee/shared`. The worker's config
   * used to be a second list carrying the comment "Same redaction posture as
   * the API", and it had already drifted: twenty-one paths against seven.
   * A comment cannot fail; this can.
   */
  it('and both produce the same redaction decision for every payload', () => {
    // Compared on the payloads that are not shaped like a Fastify request.
    // On a `req`-shaped one the two legitimately differ, and measuring that
    // difference is what showed why: the API installs a `req` serializer that
    // emits only method, url, host and remoteAddress, so it discards the whole
    // body and header set before redaction is even consulted. That is stronger
    // than redacting field by field, not weaker — and it means every
    // `req.body.*` path in the shared list is inert in the API today. They are
    // kept because they are live in the worker, and because they are what
    // stands if that serializer is ever widened.
    const plain = SECRETS.filter((s) => !('req' in s.payload()));
    expect(plain.length).toBeGreaterThan(5);

    const a = capture(); const w = capture();
    const la = apiLogger(a.stream); const lw = workerLogger(w.stream);
    for (const s of plain) { la.info(s.payload(), 'probe'); lw.info(s.payload(), 'probe'); }

    const strip = (o: Record<string, unknown>) => {
      const { time: _t, service: _s, pid: _p, hostname: _h, ...rest } = o as Record<string, unknown>;
      return rest;
    };
    expect(a.objects().map(strip)).toEqual(w.objects().map(strip));
  });

  it('the API request serializer discards the body and headers entirely', () => {
    const sink = capture();
    apiLogger(sink.stream).info({
      req: {
        method: 'POST', url: '/v1/notes', ip: '10.0.0.1',
        headers: { authorization: 'Bearer probe-token', host: 'api.example' },
        body: { text: 'probe-symptom-text', password: 'probe-password' },
      },
    }, 'request');
    const line = sink.objects()[0]!.req as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(['host', 'method', 'remoteAddress', 'url']);
    expect(sink.text()).not.toContain('probe-symptom-text');
    expect(sink.text()).not.toContain('probe-password');
    expect(sink.text()).not.toContain('probe-token');
  });

  it('positive control: an unlisted field is NOT redacted, so the probe can see a difference', () => {
    const sink = capture();
    apiLogger(sink.stream).info({ job: 'reminders', deliveryId: 'probe-delivery-id' }, 'probe');
    expect(sink.text()).toContain('probe-delivery-id');
    expect(sink.text()).toContain('reminders');
  });
});

describe('P13-2 a database error does not carry the row that caused it', () => {
  let uniqueErr: unknown;
  let fkErr: unknown;

  beforeAll(async () => {
    const c = new pg.Client({
      host: '127.0.0.1', port: 5433, user: 'postgres', password: 'postgres', database: 'dawaee_test',
    });
    await c.connect();
    await c.query('BEGIN');
    await c.query("INSERT INTO users (phone_e164, display_name) VALUES ('+966500777999','Probe')");
    try { await c.query("INSERT INTO users (phone_e164, display_name) VALUES ('+966500777999','Probe2')"); }
    catch (e) { uniqueErr = e; }
    await c.query('ROLLBACK');
    try {
      await c.query(
        "INSERT INTO consents (user_id, type, granted) VALUES ('00000000-0000-4000-8000-000000000000','privacy_policy',true)",
      );
    } catch (e) { fkErr = e; }
    await c.end();
  }, 60_000);

  it('setup: the raw error really does quote the value', () => {
    // Without this the test below could pass because Postgres stopped
    // reporting `detail` at all, rather than because the serializer drops it.
    expect((uniqueErr as { detail?: string }).detail).toContain('+966500777999');
    expect((fkErr as { detail?: string }).detail).toContain('00000000-0000-4000-8000-000000000000');
  });

  it('the phone number in `detail` never reaches the log', () => {
    const sink = capture();
    apiLogger(sink.stream).error({ err: uniqueErr, requestId: 'probe' }, 'unhandled error');
    expect(sink.text()).not.toContain('+966500777999');
    expect(sink.text()).not.toContain('detail');
  });

  it('nor does the identifier in a foreign key violation', () => {
    const sink = capture();
    apiLogger(sink.stream).error({ err: fkErr, requestId: 'probe' }, 'unhandled error');
    expect(sink.text()).not.toContain('00000000-0000-4000-8000-000000000000');
  });

  it('but what an operator needs to debug it does', () => {
    const sink = capture();
    apiLogger(sink.stream).error({ err: uniqueErr, requestId: 'probe' }, 'unhandled error');
    const err = sink.objects()[0]!.err as Record<string, unknown>;
    expect(err.code, 'the SQLSTATE is the most useful field there is').toBe('23505');
    expect(err.constraint).toBe('users_phone_e164_key');
    expect(err.table).toBe('users');
    expect(err.message).toContain('users_phone_e164_key');
    expect(err.stack).toBeTruthy();
  });

  it('the worker serializer behaves identically', () => {
    const sink = capture();
    workerLogger(sink.stream).error({ err: uniqueErr, job: 'probe' }, 'job failed');
    expect(sink.text()).not.toContain('+966500777999');
    expect((sink.objects()[0]!.err as Record<string, unknown>).code).toBe('23505');
  });

  it('a plain Error still serializes normally', () => {
    const sink = capture();
    apiLogger(sink.stream).error({ err: new Error('ordinary failure') }, 'probe');
    const err = sink.objects()[0]!.err as Record<string, unknown>;
    expect(err.message).toBe('ordinary failure');
    expect(err.type).toBe('Error');
    expect(err.stack).toBeTruthy();
  });

  it('and a non-Error thrown value does not crash the serializer', () => {
    const sink = capture();
    apiLogger(sink.stream).error({ err: 'a bare string' }, 'probe');
    expect(sink.objects()[0]!.err).toMatchObject({ type: 'string', message: 'a bare string' });
  });
});

describe('P13-3 capabilities in a URL never reach the request log', () => {
  it('rewrites the emergency scan token out of the path', () => {
    expect(redactUrl('/v1/emergency/scan/abc123def456')).toBe('/v1/emergency/scan/[redacted]');
    expect(redactUrl('/e/abc123def456')).toBe('/e/[redacted]');
    expect(redactUrl('/v1/uploads/local/key.png?expires=1&sig=deadbeef')).toBe('/v1/uploads/local/[redacted]?[redacted]');
  });

  it('leaves an ordinary path alone', () => {
    expect(redactUrl('/v1/doses?profileId=x&from=2026-09-01')).toBe('/v1/doses?profileId=x&from=2026-09-01');
    expect(redactUrl('/health')).toBe('/health');
  });

  it('and the serializer applies it', () => {
    const sink = capture();
    apiLogger(sink.stream).info({ req: { method: 'GET', url: '/v1/emergency/scan/SECRET-PROBE-TOKEN', ip: '10.0.0.1' } }, 'request');
    expect(sink.text()).not.toContain('SECRET-PROBE-TOKEN');
    expect(sink.text()).toContain('[redacted]');
  });
});

describe('P13-4 an end-to-end request writes no health data to the log', () => {
  let h: Harness;
  let user: TestUser;

  beforeAll(async () => {
    resetDatabase();
    h = await startHarness();
    user = await signIn(h, '+966500778001');
  }, 180_000);
  afterAll(async () => { await h.close(); });

  /**
   * The narrow tests above use a logger this file builds. This one drives the
   * real server and reads what the process actually wrote, so a divergence
   * between the factory and the instance Fastify ends up with would show.
   */
  it('a full medication and note lifecycle leaves nothing quotable in the output', async () => {
    const out = execFileSync('node', ['--import', 'tsx', 'test/fixtures/log-lifecycle-probe.mts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'trace',
        PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres',
      },
      timeout: 180_000,
    }).toString();

    const forbidden = [
      'Zoprexa-Probe-Med',      // the medication name
      'probe-doctor-says',      // doctor instructions
      'probe-felt-dizzy-note',  // symptom free text
      'probe-penicillin',       // an allergy
      user.phone,               // the patient's phone
    ];
    const leaked = forbidden.filter((f) => out.includes(f));
    expect(leaked, `these appeared in the process log:\n${out.slice(0, 2000)}`).toEqual([]);

    // Positive control: the probe really did run and really did log.
    expect(out, 'the probe produced no log output at all').toContain('"service":"dawaee-api"');
  }, 200_000);
});
