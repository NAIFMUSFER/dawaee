import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;

describe('Android exact-alarm release policy', () => {
  it('uses the user-granted exact-alarm permission and blocks the restricted auto-granted one', () => {
    const permissions = config.android.permissions ?? [];
    const blocked = config.android.blockedPermissions ?? [];

    expect(permissions).toContain('SCHEDULE_EXACT_ALARM');
    expect(permissions).not.toContain('USE_EXACT_ALARM');
    expect(blocked).toContain('android.permission.USE_EXACT_ALARM');
  });
});
