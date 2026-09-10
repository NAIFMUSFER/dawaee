import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Production evidence from the audit showed repeated HTTP 503 responses while
 * the API service was on Render's Free plan. Medication reminders, dose
 * confirmations and caregiver flows must not depend on an idle cold start.
 *
 * Pin the Blueprint so a future refactor cannot silently put the HTTP API back
 * on a sleeping tier. This test intentionally reads the deploy manifest rather
 * than Render itself: CI must be able to prove the release artefact requests a
 * non-sleeping plan before anybody deploys it.
 */
describe('Render production availability contract', () => {
  const yaml = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8');
  const apiStart = yaml.indexOf('    name: dawaee-api');
  const nextService = yaml.indexOf('\n  - type:', apiStart + 1);
  const apiBlock = yaml.slice(apiStart, nextService === -1 ? undefined : nextService);

  it('keeps the Dawaee API on the non-sleeping Starter plan', () => {
    expect(apiStart, 'render.yaml does not define the dawaee-api service').toBeGreaterThanOrEqual(0);
    expect(apiBlock).toMatch(/\n\s*plan:\s*starter\s*(?:#.*)?$/m);
    expect(apiBlock).not.toMatch(/\n\s*plan:\s*free\s*(?:#.*)?$/m);
  });

  it('pins Render client-IP trust to Cloudflare metadata instead of a caller-controlled forwarded chain', () => {
    expect(apiBlock).toMatch(/- key:\s*TRUST_CF_CONNECTING_IP\s*\n\s*value:\s*"true"/m);
    expect(apiBlock).toMatch(/- key:\s*TRUST_PROXY_HOPS\s*\n\s*value:\s*"1"/m);
  });
});
