import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A two-await profile bootstrap can straddle logout or account switching:
 * /v1/me may return for account A, then the runtime changes session, then
 * /v1/profiles returns for B. Without a session generation check, the stale
 * continuation can bind the local cache back to A and set signedIn=true after
 * logout. This source-bound regression was committed before the fix so the
 * missing guard is explicit evidence rather than an inferred race.
 *
 * The guard now lives in isCurrent and is called after EACH network await.
 * Keep these source-bound tripwires aligned with that predicate; executable
 * account-switch/revocation scenarios live in app-provider-request-races.
 */
const root = resolve(import.meta.dirname, '../../..');
const file = resolve(root, 'apps/mobile/src/state/app-store.tsx');
const source = readFileSync(file, 'utf8');
const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let loadMe = '';

function visit(node: ts.Node): void {
  if (
    ts.isVariableDeclaration(node)
    && node.name.getText(sf) === 'loadMe'
    && node.initializer
    && ts.isCallExpression(node.initializer)
  ) {
    loadMe = node.initializer.getText(sf);
    return;
  }
  ts.forEachChild(node, visit);
}
visit(sf);

describe('profile bootstrap belongs to the session that started it', () => {
  it('captures and rechecks a session generation across network awaits', () => {
    expect(loadMe, 'AST extraction must find the complete loadMe callback').not.toBe('');
    expect(loadMe).toMatch(/const generation\s*=\s*sessionGeneration\.current/);
    expect(loadMe).toMatch(/const isCurrent = \(\) => mounted\.current && generation === sessionGeneration\.current\s*&& request === profileLoadGeneration\.current && isSignedIn\(\);/);
    const meRead = loadMe.indexOf("('/v1/me');");
    const profilesRead = loadMe.indexOf("('/v1/profiles');");
    expect(meRead).toBeGreaterThanOrEqual(0);
    expect(profilesRead).toBeGreaterThan(meRead);
    expect(loadMe.slice(meRead, profilesRead)).toContain('if (!isCurrent()) return;');
  });

  it('never binds cache ownership after the session has disappeared', () => {
    const profilesRead = loadMe.indexOf("('/v1/profiles');");
    const guard = loadMe.indexOf('if (!isCurrent()) return;', profilesRead);
    const bind = loadMe.indexOf('setCacheOwner(me.user.id)');
    expect(profilesRead).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(profilesRead);
    expect(bind).toBeGreaterThan(guard);
    expect(loadMe.slice(0, bind)).toMatch(/&& isSignedIn\(\);/);
  });
});
