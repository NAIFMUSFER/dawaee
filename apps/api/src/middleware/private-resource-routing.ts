import type { IncomingHttpHeaders } from 'node:http';
import { PROFILE_ID_HEADER } from './profile-routing.js';

/**
 * Stable resource ids are health-adjacent identifiers in Dawaee. Render's
 * platform request logs record the public URL before the application logger can
 * redact it, so new clients use fixed public paths plus routing headers. Fastify
 * rewrites those paths internally before route matching; legacy URL routes stay
 * available during the mobile rollout.
 */
export const MEDICATION_ID_HEADER = 'x-dawaee-medication-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function routingId(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return UUID.test(value) ? value : null;
}

function splitUrl(rawUrl: string): { path: string; suffix: string } {
  const q = rawUrl.indexOf('?');
  return q === -1
    ? { path: rawUrl, suffix: '' }
    : { path: rawUrl.slice(0, q), suffix: rawUrl.slice(q) };
}

export function rewritePrivateResourceUrl(rawUrl: string, headers: IncomingHttpHeaders): string {
  const { path, suffix } = splitUrl(rawUrl);

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
