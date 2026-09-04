import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ERROR_CODES, type ApiErrorBody } from '@dawaee/shared';
import { isPgError, PG_ERRORS } from '../lib/db.js';
import { hasWebBundle, sendWebBundle } from '../routes/web-app.js';

/**
 * One place that decides what the outside world learns about a failure.
 *
 * Two rules: an unexpected error never leaks its message or stack to the
 * client, and a permission failure never reveals whether the resource exists.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id;

    if (err instanceof AppError) {
      req.log.info({ code: err.code, statusCode: err.statusCode, requestId }, 'handled application error');
      const body: ApiErrorBody = {
        error: { code: err.code, message: err.message, requestId, ...(err.details ? { details: err.details } : {}) },
      };
      return reply.status(err.statusCode).send({ ...body, ...(err.meta ? { meta: err.meta } : {}) });
    }

    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'Request validation failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          requestId,
        },
      } satisfies ApiErrorBody);
    }

    // Postgres told us "no" — usually RLS. Report it as not-found so the API
    // cannot be used to probe which patient ids exist.
    if (isPgError(err, PG_ERRORS.INSUFFICIENT_PRIVILEGE)) {
      req.log.warn({ requestId }, 'database refused the operation (RLS or grant)');
      return reply.status(404).send({
        error: { code: ERROR_CODES.NOT_FOUND, message: 'Resource not found', requestId },
      } satisfies ApiErrorBody);
    }
    if (isPgError(err, PG_ERRORS.UNIQUE_VIOLATION)) {
      return reply.status(409).send({
        error: { code: ERROR_CODES.CONFLICT, message: 'This record already exists', requestId },
      } satisfies ApiErrorBody);
    }
    // A malformed id (bad UUID, bad enum value) is the caller's mistake, not a
    // server fault. Reported as a 400 with no database detail attached.
    if (isPgError(err, PG_ERRORS.INVALID_TEXT_REPRESENTATION)) {
      return reply.status(400).send({
        error: { code: ERROR_CODES.VALIDATION_FAILED, message: 'One of the supplied values is malformed', requestId },
      } satisfies ApiErrorBody);
    }
    if (isPgError(err, PG_ERRORS.CHECK_VIOLATION) || isPgError(err, PG_ERRORS.RAISE_EXCEPTION)) {
      return reply.status(400).send({
        error: { code: ERROR_CODES.VALIDATION_FAILED, message: 'The request violates a data rule', requestId },
      } satisfies ApiErrorBody);
    }

    const statusCode = (err as FastifyError).statusCode;

    // Rate limiting is thrown, not returned, and its payload is not a
    // FastifyError. Naming it here means the caller is told to slow down —
    // with the Retry-After the plugin has already set on the reply — rather
    // than being handed the generic message below.
    if (statusCode === 429) {
      req.log.info({ requestId }, 'rate limited');
      return reply.status(429).send({
        error: { code: ERROR_CODES.RATE_LIMITED, message: 'Too many requests. Please slow down.', requestId },
      } satisfies ApiErrorBody);
    }

    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code: ERROR_CODES.VALIDATION_FAILED, message: err.message, requestId },
      } satisfies ApiErrorBody);
    }

    req.log.error({ err, requestId }, 'unhandled error');
    return reply.status(500).send({
      error: { code: ERROR_CODES.INTERNAL, message: 'An unexpected error occurred', requestId },
    } satisfies ApiErrorBody);
  });

  app.setNotFoundHandler((req, reply) => {
    // The web app routes on history paths, so a refresh on /today or a shared
    // link to /medications arrives here. Those must return the app, not a JSON
    // 404 — but only for a browser asking for a document, and never for a path
    // the API owns, so a mistyped endpoint still fails honestly.
    const wantsDocument = String(req.headers.accept ?? '').includes('text/html');
    const isApiPath = req.url.startsWith('/v1') || req.url.startsWith('/health');
    if (req.method === 'GET' && wantsDocument && !isApiPath && hasWebBundle()) {
      return sendWebBundle(reply);
    }
    return reply.status(404).send({
      error: { code: ERROR_CODES.NOT_FOUND, message: 'Route not found', requestId: req.id },
    } satisfies ApiErrorBody);
  });
}
