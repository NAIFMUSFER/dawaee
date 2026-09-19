import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** An invalid result can mean the wrong signed-in account. Keep the invitation
 * available for account switching; only expiration or consumption is terminal. */
const ROOT = resolve(import.meta.dirname, '../../..');
const ACCEPT = join(ROOT, 'apps/mobile/app/caregiver/accept.tsx');
const API = join(ROOT, 'apps/api/src/routes/caregivers.ts');

describe('caregiver invitation account switching', () => {
  it('the API classifies both missing and self-invitations as invitation_invalid', () => {
    const src = readFileSync(API, 'utf8');
    const acceptRoute = src.slice(
      src.indexOf("app.post('/v1/caregivers/accept'"),
      src.indexOf("app.patch('/v1/caregivers/:relationshipId/permissions'"),
    );

    expect(acceptRoute).toContain('ERROR_CODES.INVITATION_INVALID');
    expect(acceptRoute).toContain('AppError.badRequest(ERROR_CODES.INVITATION_INVALID');
    expect(acceptRoute).toContain('new AppError(ERROR_CODES.INVITATION_INVALID, 404');
  });

  it('preserves the token for a recipient who signed into the wrong account', () => {
    const src = readFileSync(ACCEPT, 'utf8');
    const apiErrors = src.slice(
      src.indexOf('if (err instanceof ApiError)'),
      src.indexOf("setOutcome({ kind: 'invalid', message: t('error.internal_error') })"),
    );

    const invalidBranch = /if\s*\([^)]*err\.code\s*===\s*['"]invitation_invalid['"][^)]*\)\s*\{([\s\S]*?)\n\s*\}/.exec(apiErrors)?.[1] ?? '';
    expect(invalidBranch, 'invitation_invalid must have its own error branch').not.toBe('');
    expect(invalidBranch).not.toContain('await clearPendingInvite()');
    expect(invalidBranch).toContain("setOutcome({ kind: 'invalid'");
  });
});
