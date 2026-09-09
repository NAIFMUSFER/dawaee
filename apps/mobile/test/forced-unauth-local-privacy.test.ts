import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression proof for a privacy boundary that is easy to miss in UI tests.
 *
 * Explicit sign-out already cancels scheduled local medication notifications,
 * purges the encrypted medication/offline caches, destroys the account cache
 * key and detaches the cache owner. A server-forced unauthentication (revoked
 * session, disabled account, explicit refresh rejection) must have the same
 * local privacy result. Merely changing React state to "signed out" leaves OS
 * notifications and old account cache ownership behind on a shared/lost phone.
 *
 * This test intentionally inspects the registration callback itself. It was
 * added before the product fix so the defect is demonstrated by CI: the old
 * callback only reset UI state and therefore fails every cleanup assertion.
 */
const root = resolve(import.meta.dirname, '../../..');
const source = readFileSync(resolve(root, 'apps/mobile/src/state/app-store.tsx'), 'utf8');

function unauthenticatedHandlerBody(): string {
  const start = source.indexOf('setUnauthenticatedHandler(() => {');
  expect(start, 'unauthenticated handler must be registered').toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.indexOf('\n      });');
  expect(end, 'unable to delimit unauthenticated handler').toBeGreaterThan(0);
  return rest.slice(0, end);
}

describe('server-forced unauthentication clears local patient data surfaces', () => {
  it('cancels already scheduled local medication notifications', () => {
    expect(unauthenticatedHandlerBody()).toContain('cancelAllLocalNotifications');
  });

  it('purges local queues/caches and destroys the previous account cache key', () => {
    const body = unauthenticatedHandlerBody();
    expect(body).toContain('purgeLocalCaches');
    expect(body).toContain('destroyCacheKey');
  });

  it('detaches the offline cache owner before another account can use the runtime', () => {
    expect(unauthenticatedHandlerBody()).toContain('setCacheOwner(null)');
  });
});
