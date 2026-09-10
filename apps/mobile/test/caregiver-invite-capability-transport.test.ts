import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A caregiver invitation token is a single-use bearer capability. Request
 * paths and query strings are visible to the hosting edge/access logger before
 * Dawaee's own logger can redact them, so the raw token must never be carried
 * in either transport. The emergency-card flow already uses a URL fragment for
 * exactly this reason.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const caregiverRoutes = readFileSync(
  resolve(ROOT, 'apps/api/src/routes/caregivers.ts'),
  'utf8',
);

describe('caregiver invitation capability transport', () => {
  it('keeps the raw invitation bearer out of HTTP path/query transport', () => {
    expect(caregiverRoutes).not.toContain('`${cfg.PUBLIC_APP_URL}/invite/${result.token}`');
    expect(caregiverRoutes).toContain('`${cfg.PUBLIC_APP_URL}/invite#${result.token}`');
  });
});
