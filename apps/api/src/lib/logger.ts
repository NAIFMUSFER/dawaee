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

// Typed as FastifyBaseLogger so passing the instance to Fastify does not
// specialise its logger type parameter and break route-module assignability.
export function createLogger(): FastifyBaseLogger {
  const cfg = loadConfig();
  return pino({
    level: cfg.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: { service: 'dawaee-api', env: cfg.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = FastifyBaseLogger;
