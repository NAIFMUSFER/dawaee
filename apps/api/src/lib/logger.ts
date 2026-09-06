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
 * Capabilities carried in a URL PATH, which the request log records in full.
 *
 * `redact` cannot reach these: it matches object paths like `req.body.token`,
 * and this secret is a path segment inside the `req.url` string. Fastify's
 * default request serializer writes that string verbatim — verified, not
 * assumed:
 *
 *   {"req":{"method":"GET","url":"/v1/emergency/scan/SECRET-TOKEN-VALUE…"}}
 *
 * The emergency scan token is a 192-bit bearer capability that returns a
 * patient's blood type, allergies, conditions, medications and their emergency
 * contacts' phone numbers, to anyone holding it, with no authentication. Every
 * scan was writing that token into the application log in plaintext — logs that
 * leave the process for an aggregator and are kept far longer than the token
 * lives. Anyone who could read logs could replay any card that had been
 * scanned.
 *
 * Rewritten rather than dropped: the path is worth having in the log, and
 * knowing that an emergency card was read is exactly the kind of event an
 * operator should be able to see. Only the secret goes.
 */
const PATH_SECRETS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /^\/v1\/emergency\/scan\/[^/?]+/, replace: '/v1/emergency/scan/[redacted]' },
  { pattern: /^\/e\/[^/?]+/, replace: '/e/[redacted]' },
  // The local development storage sink signs the object key into the query
  // string; the signature is a capability for that object.
  { pattern: /^(\/v1\/uploads\/local\/[^?]*)\?.*$/, replace: '$1?[redacted]' },
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
  for (const { pattern, replace } of PATH_SECRETS) {
    if (pattern.test(url)) return url.replace(pattern, replace);
  }
  return url;
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
