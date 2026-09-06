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
    //
    // `22007` and `2201W` were added after measuring what the API actually
    // returned for ordinary bad input. `22P02` was already covered, so a bad
    // UUID or enum was correctly a 400 — but a malformed date (`?from=abc`,
    // and `?endDate=abc` via `addDays`, which yields the string
    // "0NaN-NaN-NaN") raises `22007`, and `?limit=-5` raises `2201W`. Neither
    // was mapped, so both fell through to the 500 branch: logged as an
    // unhandled server error and reported to the client as one. Route-level
    // validation now rejects these earlier; this stays as the backstop, so a
    // future route that forgets returns a 400 rather than a false 500.
    if (
      isPgError(err, PG_ERRORS.INVALID_TEXT_REPRESENTATION) ||
      isPgError(err, PG_ERRORS.INVALID_DATETIME_FORMAT) ||
      isPgError(err, PG_ERRORS.INVALID_ROW_COUNT_IN_LIMIT)
    ) {
      return reply.status(400).send({
        error: { code: ERROR_CODES.VALIDATION_FAILED, message: 'One of the supplied values is malformed', requestId },
      } satisfies ApiErrorBody);
    }
    /**
     * A foreign key violation is almost always a caller referring to something
     * that is not there — a stale offline queue replaying a note for a dose
     * since deleted — and it was reaching the 500 branch, so an ordinary
     * client mistake was reported as a server fault and logged as an unhandled
     * error.
     *
     * Unlike the malformed-input codes above, this one is genuinely ambiguous:
     * it can also mean a real bug, a race or a missing cascade. So it is
     * mapped to a 400 for the caller *and* logged with its constraint, which
     * is the field that says which of the two it was. The constraint name is
     * safe to log; `detail`, which quotes the offending value, is dropped by
     * the error serializer.
     */
    if (isPgError(err, PG_ERRORS.FOREIGN_KEY_VIOLATION)) {
      req.log.warn(
        { requestId, constraint: (err as { constraint?: string }).constraint },
        'request referenced a row that does not exist',
      );
      return reply.status(400).send({
        error: { code: ERROR_CODES.VALIDATION_FAILED, message: 'One of the referenced records does not exist', requestId },
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
