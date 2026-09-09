import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Permanent invalid caregiver invitations must be forgotten.
 *
 * The API deliberately returns invitation_invalid for both a nonexistent token
 * (404) and an attempt to accept one's own invitation (400). The mobile accept
 * screen stores the bearer before the auth detour. If it renders the permanent
 * error without clearing that stored token, the next successful sign-in routes
 * straight back to /caregiver/accept. In the same process the process-wide
 * claim guard then refuses to submit the token a second time, leaving the new
 * screen in its idle/loading state forever.
 *
 * This is a source-contract regression because the screen owns the error side
 * effect. Network/provider failures are intentionally NOT included: those are
 * retryable and must retain the invitation.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const ACCEPT = join(ROOT, 'apps/mobile/app/caregiver/accept.tsx');
const API = join(ROOT, 'apps/api/src/routes/caregivers.ts');

describe('permanent invalid caregiver invitation cleanup', () => {
  it('the API classifies both missing and self-invitations as invitation_invalid', () => {
    const src = readFileSync(API, 'utf8');
    const acceptRoute = src.slice(
      src.indexOf("app.post('/v1/caregivers/accept'"),
      src.indexOf("app.patch('/v1/caregivers/:relationshipId/permissions'"),
    );

    expect(acceptRoute).toContain("ERROR_CODES.INVITATION_INVALID");
    expect(acceptRoute).toContain("AppError.badRequest(ERROR_CODES.INVITATION_INVALID");
    expect(acceptRoute).toContain("new AppError(ERROR_CODES.INVITATION_INVALID, 404");
  });

  it('clears a stashed token when invitation_invalid is permanent', () => {
    const src = readFileSync(ACCEPT, 'utf8');
    const apiErrors = src.slice(
      src.indexOf('if (err instanceof ApiError)'),
      src.indexOf("setOutcome({ kind: 'invalid', message: t('error.internal_error') })"),
    );

    const invalidBranch = /if\s*\([^)]*err\.code\s*===\s*['\"]invitation_invalid['\"][^)]*\)\s*\{([\s\S]*?)\n\s*\}/.exec(apiErrors)?.[1] ?? '';
    expect(invalidBranch, 'invitation_invalid must have its own permanent-error branch').not.toBe('');
    expect(invalidBranch).toContain('await clearPendingInvite()');
    expect(invalidBranch).toContain("setOutcome({ kind: 'invalid'");
  });
});
