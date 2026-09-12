import type { FastifyRequest } from 'fastify';
import { AppError, ERROR_CODES } from '@dawaee/shared';

/**
 * Stable patient-profile identifiers are routing metadata, but they are also
 * health-adjacent identifiers. Render production request logs retain the full
 * URL before Dawaee's logger can redact it, so new clients send this value in a
 * dedicated header rather than query text.
 *
 * Legacy query transport remains readable during the mobile rollout. If both
 * forms are present they must agree; silently preferring either side would
 * create an ambiguous authorization target and make downgrade bugs difficult
 * to detect.
 */
export const PROFILE_ID_HEADER = 'x-dawaee-profile-id';
export const OBJECT_KEY_HEADER = 'x-dawaee-object-key';

type RoutableRequest = {
  headers: FastifyRequest['headers'];
  query: FastifyRequest['query'];
};

function requireMutableQuery(req: RoutableRequest): Record<string, unknown> {
  if (!req.query || typeof req.query !== 'object' || Array.isArray(req.query)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid request query');
  }
  return req.query as Record<string, unknown>;
}

export function promoteProfileIdHeader(req: RoutableRequest): void {
  const rawHeader = req.headers[PROFILE_ID_HEADER];
  if (rawHeader === undefined) return;

  if (Array.isArray(rawHeader)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid profile routing metadata');
  }

  const headerProfileId = rawHeader.trim();
  if (!headerProfileId) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid profile routing metadata');
  }

  const query = requireMutableQuery(req);
  const legacyProfileId = query.profileId;
  if (
    legacyProfileId !== undefined
    && legacyProfileId !== null
    && legacyProfileId !== ''
    && String(legacyProfileId) !== headerProfileId
  ) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Conflicting profile routing metadata');
  }

  query.profileId = headerProfileId;
}

/**
 * The object key returned by an upload ticket is a private correlation handle:
 * it identifies both the upload purpose and one stored object. Platform access
 * logs see query strings before application redaction, so the signed-read
 * endpoint accepts the key in dedicated request metadata for new clients.
 *
 * Keep the legacy query form during rollout, but require both transports to
 * agree when they are present. The established handler still performs the same
 * RLS and caregiver-permission checks after this promotion.
 */
export function promoteObjectKeyHeader(req: RoutableRequest): void {
  const rawHeader = req.headers[OBJECT_KEY_HEADER];
  if (rawHeader === undefined) return;

  if (Array.isArray(rawHeader)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid upload routing metadata');
  }

  const headerObjectKey = rawHeader.trim();
  if (!headerObjectKey) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid upload routing metadata');
  }

  const query = requireMutableQuery(req);
  const legacyObjectKey = query.objectKey;
  if (
    legacyObjectKey !== undefined
    && legacyObjectKey !== null
    && legacyObjectKey !== ''
    && String(legacyObjectKey) !== headerObjectKey
  ) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Conflicting upload routing metadata');
  }

  query.objectKey = headerObjectKey;
}
