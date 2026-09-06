import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { loadConfig } from '../config.js';

/**
 * Structured logging with health data kept OUT of the logs.
 *
 * Observability requirement from the brief: never unnecessarily log medication
 * names or health data. Redaction is enforced here rather than left to each call
 * site, because one careless `log.info({ medication })` would otherwise leak
 * medical information into an aggregator forever.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.code',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.phone',
  'req.body.name',
  'req.body.brandName',
  'req.body.genericName',
  'req.body.instructions',
  'req.body.doctorInstructions',
  'req.body.notes',
  'req.body.allergies',
  'req.body.conditionsNote',
  'medication',
  'medicationName',
  'allergies',
  'phone',
  'phoneE164',
  'invitedPhone',
  '*.medicationName',
  '*.phoneE164',
];

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
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: { service: 'dawaee-api', env: cfg.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
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
