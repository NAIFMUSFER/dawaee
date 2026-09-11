import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * P20 upload-retention regression.
 *
 * Direct S3/R2 PUTs bypass the API while bytes are transferred. The explicit
 * finalization route now verifies the stored bytes against the approved lease
 * and is the only path that makes `stored_objects.uploaded_at` authoritative.
 * Housekeeping must still never delete metadata that live patient data already
 * references, regardless of age or completion state.
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

  it('makes uploaded_at authoritative only through explicit verified finalization', () => {
    const route = readFileSync(new URL('../src/routes/uploads.ts', import.meta.url), 'utf8');
    expect(route).toContain("app.post('/v1/uploads/finalize'");
    expect(route).toMatch(/SET\s+uploaded_at\s*=\s*now\(\),\s*scan_status\s*=\s*'clean'/i);
    // Both signed-read and OCR paths stay fail-closed for a staged lease.
    expect(route.match(/!object\.uploaded_at/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
