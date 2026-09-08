import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * P20 upload-retention regression.
 *
 * Direct S3/R2 PUTs do not call the API after the bytes arrive, so
 * `stored_objects.uploaded_at` is not currently an authoritative completion
 * signal. Housekeeping must therefore never delete a ticket that patient data
 * already references merely because uploaded_at is still NULL.
 */
describe('upload retention does not erase authorization metadata for live images', () => {
  it('protects every current image reference surface before deleting an abandoned ticket', () => {
    const src = readFileSync(new URL('../../worker/src/jobs/housekeeping.ts', import.meta.url), 'utf8');
    expect(src).toContain('DELETE FROM stored_objects so');
    expect(src).toContain('m.image_key = so.object_key');
    expect(src).toContain('p.image_key = so.object_key');
    expect(src).toContain('pp.avatar_key = so.object_key');
  });

  it('does not pretend uploaded_at is currently acknowledged by the upload route', () => {
    const route = readFileSync(new URL('../src/routes/uploads.ts', import.meta.url), 'utf8');
    // A future explicit completion endpoint may make uploaded_at authoritative.
    // Until then, this absence is exactly why reference checks are mandatory.
    expect(route).not.toMatch(/UPDATE\s+stored_objects[\s\S]{0,200}uploaded_at\s*=/i);
  });
});
