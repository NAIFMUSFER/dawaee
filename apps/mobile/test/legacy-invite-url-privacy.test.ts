import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const legacyEntry = readFileSync(resolve(ROOT, 'apps/mobile/app/invite/[token].tsx'), 'utf8');
const acceptScreen = readFileSync(resolve(ROOT, 'apps/mobile/app/caregiver/accept.tsx'), 'utf8');

describe('legacy caregiver invitation URL privacy', () => {
  it('does not forward the legacy bearer into a second path/query URL', () => {
    expect(legacyEntry).not.toContain('Redirect');
    expect(legacyEntry).not.toMatch(/params\s*:\s*\{\s*token/);
    expect(legacyEntry).toContain('await stashPendingInvite(token)');
    expect(legacyEntry).toContain("router.replace('/caregiver/accept')");
  });

  it('keeps the fixed accept screen able to resume from the pending-invite store', () => {
    expect(acceptScreen).toContain('const stored = await peekPendingInvite()');
    expect(acceptScreen).toContain('if (params.token)');
  });
});
