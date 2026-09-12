import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyRequest } from 'fastify';
import { AppError, ERROR_CODES } from '@dawaee/shared';
import { PROFILE_ID_HEADER } from './profile-routing.js';

/**
 * Stable resource ids are health-adjacent identifiers in Dawaee. Render's
 * platform request logs record the public URL before the application logger can
 * redact it, so new clients use fixed public paths plus routing headers. Fastify
 * rewrites those paths internally before route matching; legacy URL routes stay
 * available during the mobile rollout.
 */
export const MEDICATION_ID_HEADER = 'x-dawaee-medication-id';
export const SCHEDULE_ID_HEADER = 'x-dawaee-schedule-id';
export const DOSE_ID_HEADER = 'x-dawaee-dose-id';
export const DEVICE_ID_HEADER = 'x-dawaee-device-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ID = /^[A-Za-z0-9._~-]{1,128}$/;

function routingId(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return UUID.test(value) ? value : null;
}

function deviceRoutingId(headers: IncomingHttpHeaders): string | null {
  const raw = headers[DEVICE_ID_HEADER];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return DEVICE_ID.test(value) ? value : null;
}

function splitUrl(rawUrl: string): { path: string; suffix: string } {
  const q = rawUrl.indexOf('?');
  return q === -1
    ? { path: rawUrl, suffix: '' }
    : { path: rawUrl.slice(0, q), suffix: rawUrl.slice(q) };
}

/**
 * Medication filters are identifiers too. A list request such as dose history
 * used to move the profile id into a header while leaving `medicationId` in the
 * query string, which still exposed exactly which medicine was being viewed in
 * Render's upstream request log. Promote the same private header back into the
 * established query contract after the request has crossed that logging layer.
 */
export function promoteMedicationIdHeader(req: {
  headers: FastifyRequest['headers'];
  query: FastifyRequest['query'];
}): void {
  const rawHeader = req.headers[MEDICATION_ID_HEADER];
  if (rawHeader === undefined) return;
  if (Array.isArray(rawHeader)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid medication routing metadata');
  }

  const headerMedicationId = rawHeader.trim();
  if (!UUID.test(headerMedicationId)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid medication routing metadata');
  }
  if (!req.query || typeof req.query !== 'object' || Array.isArray(req.query)) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Invalid request query');
  }

  const query = req.query as Record<string, unknown>;
  const legacyMedicationId = query.medicationId;
  if (
    legacyMedicationId !== undefined
    && legacyMedicationId !== null
    && legacyMedicationId !== ''
    && String(legacyMedicationId) !== headerMedicationId
  ) {
    throw AppError.badRequest(ERROR_CODES.VALIDATION_FAILED, 'Conflicting medication routing metadata');
  }
  query.medicationId = headerMedicationId;
}

export function rewritePrivateResourceUrl(rawUrl: string, headers: IncomingHttpHeaders): string {
  const { path, suffix } = splitUrl(rawUrl);

  const deviceId = deviceRoutingId(headers);
  if (deviceId && path === '/v1/devices/push-token') {
    return `/v1/devices/push-token/${encodeURIComponent(deviceId)}${suffix}`;
  }

  const doseId = routingId(headers, DOSE_ID_HEADER);
  if (doseId && path === '/v1/dose') {
    return `/v1/doses/${doseId}${suffix}`;
  }

  const scheduleId = routingId(headers, SCHEDULE_ID_HEADER);
  if (scheduleId && path === '/v1/schedule') {
    return `/v1/schedules/${scheduleId}${suffix}`;
  }

  const medicationId = routingId(headers, MEDICATION_ID_HEADER);
  if (medicationId) {
    const medicationTargets: Record<string, string> = {
      '/v1/medication': `/v1/medications/${medicationId}`,
      '/v1/medication/stock': `/v1/medications/${medicationId}/stock`,
      '/v1/medication/refill': `/v1/medications/${medicationId}/refill`,
      '/v1/medication/schedules': `/v1/medications/${medicationId}/schedules`,
    };
    const target = medicationTargets[path];
    if (target) return `${target}${suffix}`;
  }

  const profileId = routingId(headers, PROFILE_ID_HEADER);
  if (profileId) {
    const profileTargets: Record<string, string> = {
      '/v1/profile': `/v1/profiles/${profileId}`,
      '/v1/profile/timezone-check': `/v1/profiles/${profileId}/timezone-check`,
      '/v1/profile/timezone-decision': `/v1/profiles/${profileId}/timezone-decision`,
    };
    const target = profileTargets[path];
    if (target) return `${target}${suffix}`;
  }

  return rawUrl;
}
