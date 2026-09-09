import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A two-await profile bootstrap can straddle logout or account switching:
 * /v1/me may return for account A, then the runtime changes session, then
 * /v1/profiles returns for B. Without a session generation check, the stale
 * continuation can bind the local cache back to A and set signedIn=true after
 * logout. This source-bound regression was committed before the fix so the
 * missing guard is explicit evidence rather than an inferred race.
 */
const root = resolve(import.meta.dirname, '../../..');
const source = readFileSync(resolve(root, 'apps/mobile/src/state/app-store.tsx'), 'utf8');
const loadStart = source.indexOf('const loadMe = useCallback(async () => {');
const loadEnd = source.indexOf('\n  }, []);', loadStart);
const loadMe = source.slice(loadStart, loadEnd);

describe('profile bootstrap belongs to the session that started it', () => {
  it('captures and rechecks a session generation across network awaits', () => {
    expect(loadStart).toBeGreaterThanOrEqual(0);
    expect(loadMe).toContain('sessionGeneration.current');
    expect(loadMe).toMatch(/generation\s*!==\s*sessionGeneration\.current/);
  });

  it('never binds cache ownership after the session has disappeared', () => {
    const guard = loadMe.indexOf('generation !== sessionGeneration.current');
    const bind = loadMe.indexOf('setCacheOwner(me.user.id)');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(bind).toBeGreaterThan(guard);
    expect(loadMe.slice(0, bind)).toContain('!isSignedIn()');
  });
});
