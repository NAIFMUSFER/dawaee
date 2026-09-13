import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/lib/logger.js';

/**
 * Production evidence on 2026-09-09 showed Render request logs retaining full
 * patient profile UUIDs on medication/adherence routes next to client network
 * metadata. These are stable health-related identifiers and do not need to
 * leave the process for request diagnostics.
 */
describe('request URL privacy redaction', () => {
  const profileId = '11111111-1111-4111-8111-111111111111';
  const doseId = '22222222-2222-4222-8222-222222222222';
  const medicationId = '33333333-3333-4333-8333-333333333333';

  it('redacts a patient profile id from medication, today, and dose-list query strings', () => {
    expect(redactUrl(`/v1/today?profileId=${profileId}`)).toBe('/v1/today?profileId=[id]');
    expect(redactUrl(`/v1/medications?profileId=${profileId}&status=active`))
      .toBe('/v1/medications?profileId=[id]&status=active');
    expect(redactUrl(`/v1/doses?profileId=${profileId}&from=2026-09-06&to=2026-09-12&medicationId=${medicationId}`))
      .toBe('/v1/doses?profileId=[id]&from=2026-09-06&to=2026-09-12&medicationId=[id]');
  });

  it('redacts health-linked ids carried as route parameters', () => {
    expect(redactUrl(`/v1/doses/${doseId}/taken`)).toBe('/v1/doses/[id]/taken');
    expect(redactUrl(`/v1/medications/${medicationId}`)).toBe('/v1/medications/[id]');
  });

  it('redacts the entire local object key as well as its signed query', () => {
    const objectId = '44444444-4444-4444-8444-444444444444';
    const url = `/v1/uploads/local/medication_image%2F2026-09-10%2Fdeadbeef%2F${objectId}.png?expires=1790000000&sig=test-signature`;
    expect(redactUrl(url)).toBe('/v1/uploads/local/[redacted]?[redacted]');
  });

  it('keeps non-identifying route and filter information useful for diagnostics', () => {
    expect(redactUrl('/v1/doses?status=missed&from=2026-09-06&to=2026-09-12'))
      .toBe('/v1/doses?status=missed&from=2026-09-06&to=2026-09-12');
    expect(redactUrl('/health/ready')).toBe('/health/ready');
  });
});
