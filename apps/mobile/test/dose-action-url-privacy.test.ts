import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const today = readFileSync(resolve(root, 'apps/mobile/app/(tabs)/today.tsx'), 'utf8');
const notificationActions = readFileSync(resolve(root, 'apps/mobile/src/notifications/actions.ts'), 'utf8');

/**
 * Render owns the request log in front of the API, so application logger
 * redaction cannot rescue an identifier that the client already placed in the
 * URL. Keep this as a source-level release regression: both foreground and
 * lock-screen action paths must stay fixed before any request is constructed.
 */
describe('mobile dose action URL privacy', () => {
  it('does not interpolate a dose identifier into Today action URLs', () => {
    expect(today).not.toContain('`/v1/doses/${dose.id}/taken`');
    expect(today).not.toContain('`/v1/doses/${dose.id}/skip`');
    expect(today).not.toContain('`/v1/doses/${dose.id}/snooze`');
    expect(today).not.toContain('`/v1/doses/${dose.id}/undo`');
    expect(today.match(/api\.post\('\/v1\/dose\/action'/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('does not regress notification actions to identifier-bearing routes', () => {
    expect(notificationActions).not.toContain('`/v1/doses/${doseId}/taken`');
    expect(notificationActions).not.toContain('`/v1/doses/${doseId}/skip`');
    expect(notificationActions).not.toContain('`/v1/doses/${doseId}/snooze`');
    expect(notificationActions.match(/api\.post\('\/v1\/dose\/action'/g)?.length ?? 0).toBe(3);
  });

  it('keeps the id and semantic action in JSON rather than the public path', () => {
    expect(today).toContain("{ doseId: dose.id, action: 'taken'");
    expect(today).toContain("{ doseId: dose.id, action: 'skip'");
    expect(today).toContain("{ doseId: dose.id, action: 'snooze'");
    expect(today).toContain("{ doseId: dose.id, action: 'undo'");
    expect(notificationActions).toContain("doseId, action: 'taken'");
  });
});
