import { describe, expect, it } from 'vitest';
import {
  MEDICATION_ID_HEADER, SCHEDULE_ID_HEADER, promoteMedicationIdHeader, rewritePrivateResourceUrl,
} from '../src/middleware/private-resource-routing.js';
import { PROFILE_ID_HEADER } from '../src/middleware/profile-routing.js';

const MEDICATION_ID = '11111111-2222-4333-8444-555555555555';
const PROFILE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SCHEDULE_ID = '99999999-8888-4777-8666-555555555555';

describe('fixed public resource paths', () => {
  it.each([
    ['/v1/medication', `/v1/medications/${MEDICATION_ID}`],
    ['/v1/medication/stock', `/v1/medications/${MEDICATION_ID}/stock`],
    ['/v1/medication/refill', `/v1/medications/${MEDICATION_ID}/refill`],
    ['/v1/medication/schedules', `/v1/medications/${MEDICATION_ID}/schedules`],
  ])('rewrites %s internally without putting the id in the public path', (publicPath, internalPath) => {
    expect(rewritePrivateResourceUrl(publicPath, { [MEDICATION_ID_HEADER]: MEDICATION_ID })).toBe(internalPath);
    expect(publicPath).not.toContain(MEDICATION_ID);
  });

  it('rewrites a schedule update internally without exposing its id', () => {
    const publicPath = '/v1/schedule';
    expect(rewritePrivateResourceUrl(publicPath, { [SCHEDULE_ID_HEADER]: SCHEDULE_ID }))
      .toBe(`/v1/schedules/${SCHEDULE_ID}`);
    expect(publicPath).not.toContain(SCHEDULE_ID);
  });

  it.each([
    ['/v1/profile', `/v1/profiles/${PROFILE_ID}`],
    ['/v1/profile/timezone-check', `/v1/profiles/${PROFILE_ID}/timezone-check`],
    ['/v1/profile/timezone-decision', `/v1/profiles/${PROFILE_ID}/timezone-decision`],
  ])('rewrites %s through the existing profile route', (publicPath, internalPath) => {
    expect(rewritePrivateResourceUrl(publicPath, { [PROFILE_ID_HEADER]: PROFILE_ID })).toBe(internalPath);
  });

  it('preserves non-sensitive query parameters across the internal rewrite', () => {
    expect(rewritePrivateResourceUrl('/v1/medication?force=true', { [MEDICATION_ID_HEADER]: MEDICATION_ID }))
      .toBe(`/v1/medications/${MEDICATION_ID}?force=true`);
  });

  it('promotes a medication header back into the legacy query contract', () => {
    const req = { headers: { [MEDICATION_ID_HEADER]: MEDICATION_ID }, query: { from: '2026-09-01' } };
    promoteMedicationIdHeader(req as never);
    expect(req.query).toEqual({ from: '2026-09-01', medicationId: MEDICATION_ID });
  });

  it('rejects conflicting or malformed medication routing metadata', () => {
    expect(() => promoteMedicationIdHeader({
      headers: { [MEDICATION_ID_HEADER]: MEDICATION_ID },
      query: { medicationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    } as never)).toThrow();
    expect(() => promoteMedicationIdHeader({
      headers: { [MEDICATION_ID_HEADER]: '../admin' }, query: {},
    } as never)).toThrow();
  });

  it('does not let a malformed routing header become part of a route', () => {
    expect(rewritePrivateResourceUrl('/v1/medication', { [MEDICATION_ID_HEADER]: '../admin' }))
      .toBe('/v1/medication');
    expect(rewritePrivateResourceUrl('/v1/schedule', { [SCHEDULE_ID_HEADER]: '../admin' }))
      .toBe('/v1/schedule');
    expect(rewritePrivateResourceUrl('/v1/profile', { [PROFILE_ID_HEADER]: 'not-a-uuid' }))
      .toBe('/v1/profile');
  });

  it('does not rewrite unrelated routes or fixed paths without metadata', () => {
    expect(rewritePrivateResourceUrl('/v1/today', { [MEDICATION_ID_HEADER]: MEDICATION_ID })).toBe('/v1/today');
    expect(rewritePrivateResourceUrl('/v1/medication/stock', {})).toBe('/v1/medication/stock');
    expect(rewritePrivateResourceUrl('/v1/schedule', {})).toBe('/v1/schedule');
  });
});