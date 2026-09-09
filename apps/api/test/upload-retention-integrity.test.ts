import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * P20 upload-retention regression.
 *
 * Direct S3/R2 PUTs do not call the API after the bytes arrive, so
 * `stored_objects.uploaded_at` is not currently an authoritative completion
 * signal. Housekeeping must therefore never delete a ticket that patient data
 * already references merely because uploaded_at is still NULL.
 *
 * The reference query intentionally lives in a SECURITY DEFINER helper. The
 * least-privilege worker cannot SELECT prescriptions, and CI proved that doing
 * this query directly made the whole housekeeping run fail before account
 * erasure. The helper returns object keys only; it does not widen PHI access.
 */
describe('upload retention does not erase authorization metadata for live images', () => {
  it('protects every current image reference surface inside the narrow DB helper', () => {
    const migration = readFileSync(
      new URL('../../../db/migrations/0039_worker_retention_boundaries.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('app.list_abandoned_object_keys');
    expect(migration).toContain('m.image_key = so.object_key');
    expect(migration).toContain('p.image_key = so.object_key');
    expect(migration).toContain('pp.avatar_key = so.object_key');
    expect(migration).toContain('REVOKE SELECT, DELETE ON stored_objects FROM dawaee_worker');
  });

  it('has housekeeping consume only the bounded helper output, not prescription rows', () => {
    const src = readFileSync(new URL('../../worker/src/jobs/housekeeping.ts', import.meta.url), 'utf8');
    expect(src).toContain('app.list_abandoned_object_keys(24, 100)');
    expect(src).toContain('app.remove_abandoned_object_metadata($1)');
    expect(src).not.toContain('FROM prescriptions');
  });

  it('does not pretend uploaded_at is currently acknowledged by the upload route', () => {
    const route = readFileSync(new URL('../src/routes/uploads.ts', import.meta.url), 'utf8');
    // A future explicit completion endpoint may make uploaded_at authoritative.
    // Until then, this absence is exactly why reference checks are mandatory.
    expect(route).not.toMatch(/UPDATE\s+stored_objects[\s\S]{0,200}uploaded_at\s*=/i);
  });
});
