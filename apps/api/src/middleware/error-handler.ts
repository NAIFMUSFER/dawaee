import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ERROR_CODES, type ApiErrorBody } from '@dawaee/shared';
import { isPgError, PG_ERRORS } from '../lib/db.js';

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

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: ERROR_CODES.NOT_FOUND, message: 'Route not found', requestId: req.id },
    } satisfies ApiErrorBody),
  );
}
