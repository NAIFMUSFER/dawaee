import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOG_REDACTED_PATHS } from '@dawaee/shared';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;
let token = '';
let qrUrl = '';

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '+966500099901');
  const enabled = await h.app.inject({
    method: 'POST',
    url: `/v1/emergency/qr/enable?profileId=${user.profileId}`,
    headers: authHeaders(user),
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  ({ token, qrUrl } = enabled.json<{ token: string; qrUrl: string }>());
});

afterAll(async () => { await h.close(); });

describe('P20 emergency bearer capability transport', () => {
  it('puts the QR capability in a fragment, never the HTTP path or query', () => {
    expect(qrUrl).toContain('/e#');
    expect(qrUrl).not.toContain(`/e/${token}`);
    expect(new URL(qrUrl).pathname.endsWith('/e')).toBe(true);
    expect(new URL(qrUrl).search).toBe('');
    expect(new URL(qrUrl).hash.slice(1)).toBe(token);
  });

  it('resolves a valid card from a fixed request path with the token in Authorization', async () => {
    const scan = await h.app.inject({
      method: 'GET',
      url: '/v1/emergency/scan/card',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(scan.statusCode, scan.body).toBe(200);
    expect(scan.body).not.toContain(token);
  });

  it('the application log policy redacts Authorization', () => {
    expect(LOG_REDACTED_PATHS).toContain('req.headers.authorization');
  });

  it('production route code never treats the path segment as the capability', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const route = readFileSync(resolve(root, 'apps/api/src/routes/emergency.ts'), 'utf8');
    expect(route).toContain("bearer ?? (cfg.NODE_ENV === 'test' ? legacyPathToken : undefined)");
    expect(route).not.toMatch(/bearer\s*\?\?\s*legacyPathToken(?!.*NODE_ENV)/);
  });

  it('the public screen consumes and erases the fragment before using a fixed scan path', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const screen = readFileSync(resolve(root, 'apps/mobile/app/e/index.tsx'), 'utf8');
    expect(screen).toContain('window.location.hash.slice(1)');
    expect(screen).toContain('window.history.replaceState');
    expect(screen).toContain('/v1/emergency/scan/card');
    expect(screen).toContain('authorization: `Bearer ${token}`');
    expect(screen).not.toContain('/v1/emergency/scan/${token}');
  });
});
