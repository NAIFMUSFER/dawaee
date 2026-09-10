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

export function promoteProfileIdHeader(req: {
  headers: FastifyRequest['headers'];
  query: FastifyRequest['query'];
}): void {
  const rawHeader = req.headers[PROFILE_ID_HEADER];
  if (rawHeader === undefined) return;

  if (Array.isArray(rawHeader)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid profile routing metadata');
  }

  const headerProfileId = rawHeader.trim();
  if (!headerProfileId) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid profile routing metadata');
  }

  if (!req.query || typeof req.query !== 'object' || Array.isArray(req.query)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid request query');
  }

  const query = req.query as Record<string, unknown>;
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
