import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { LOG_REDACTION, serializeLoggedError } from '@dawaee/shared';
import { loadConfig } from '../config.js';

/**
 * Structured logging with health data kept OUT of the logs.
 *
 * Observability requirement from the brief: never unnecessarily log medication
 * names or health data. Redaction is enforced here rather than left to each call
 * site, because one careless `log.info({ medication })` would otherwise leak
 * medical information into an aggregator forever.
 *
 * The policy itself — which paths are redacted, and what survives from a
 * thrown error — lives in `@dawaee/shared`, because the worker writes logs
 * too and the two lists had already drifted apart while each claimed to match
 * the other.
 */

/**
 * Stable record identifiers are health-related identifiers once they occur in
 * a Dawaee request URL. Production request logs proved this was not theoretical:
 * `/v1/today`, `/v1/medications` and `/v1/doses` were persisted with full
 * patient profile UUIDs next to caller network metadata. Route parameters can
 * similarly carry dose or medication UUIDs.
 *
 * Keep the route shape for operations, but remove the stable identifier that
 * lets an aggregator correlate one patient's medication/adherence activity.
 */
const URL_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Capabilities and opaque object identifiers carried in a URL, which the
 * request log records in full.
 *
 * `redact` cannot reach these: it matches object paths like `req.body.token`,
 * and these values live inside the `req.url` string. Fastify's request
 * serializer therefore has to rewrite them before the log line leaves the
 * process.
 */
const PATH_SECRETS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /^\/v1\/emergency\/scan\/[^/?]+/, replace: '/v1/emergency/scan/[redacted]' },
  { pattern: /^\/e\/[^/?]+/, replace: '/e/[redacted]' },
  /**
   * Local development object keys contain a patient-profile prefix plus a
   * random object UUID, while the query string carries a signed capability.
   * Neither has diagnostic value. Redact the whole key, not just the signature.
   */
  { pattern: /^(\/v1\/uploads\/local)\/[^?]+\?.*$/, replace: '$1/[redacted]?[redacted]' },
  { pattern: /^(\/v1\/uploads\/local)\/[^?]+$/, replace: '$1/[redacted]' },
  /**
   * `?objectKey=` on the signed-read endpoint.
   *
   * The key alone is not a capability — RLS on `stored_objects` decides whether
   * the caller may have a signed URL for it — but it is an unguessable
   * identifier for one patient's prescription or medication photograph, it is
   * the sole input to the endpoint that mints that capability, and it has no
   * diagnostic value in a request log. The path and the outcome are the useful
   * parts and they survive.
   */
  { pattern: /^(\/v1\/uploads\/url)\?.*$/, replace: '$1?[redacted]' },
];

export function redactUrl(url: string): string {
  let redacted = url;
  for (const { pattern, replace } of PATH_SECRETS) {
    if (pattern.test(redacted)) {
      redacted = redacted.replace(pattern, replace);
      break;
    }
  }
  return redacted.replace(URL_UUID, '[id]');
}

// Typed as FastifyBaseLogger so passing the instance to Fastify does not
// specialise its logger type parameter and break route-module assignability.
export function createLogger(): FastifyBaseLogger {
  const cfg = loadConfig();
  return pino({
    level: cfg.LOG_LEVEL,
    redact: LOG_REDACTION,
    base: { service: 'dawaee-api', env: cfg.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      // Replaces pino's default, which copies every property of the thrown
      // object — including the ones a DatabaseError uses to quote row values.
      err: serializeLoggedError,
      // Replaces Fastify's default request serializer. Same fields, minus the
      // secret. Anything added here must keep `url` going through redactUrl.
      req(req: { method?: string; url?: string; headers?: Record<string, unknown>; ip?: string }) {
        return {
          method: req.method,
          url: redactUrl(req.url ?? ''),
          host: req.headers?.host,
          remoteAddress: req.ip,
        };
      },
    },
  });
}

export type Logger = FastifyBaseLogger;
