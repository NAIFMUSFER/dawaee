import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { createHarness, ApiError } = createRequire(import.meta.url)('./profile-screen-harness.cjs');

/** An invalid result can mean the wrong signed-in account. Keep the invitation
 * available for account switching; only expiration or consumption is terminal. */
const ROOT = resolve(import.meta.dirname, '../../..');
const ACCEPT = join(ROOT, 'apps/mobile/app/caregiver/accept.tsx');
const API = join(ROOT, 'apps/api/src/routes/caregivers.ts');

describe('caregiver invitation account switching', () => {
  it('the current preview and reviewed acceptance expose invitation_invalid refusals', () => {
    const src = readFileSync(API, 'utf8');
    const preview = src.slice(src.indexOf("app.post('/v1/caregivers/invitations/preview'"), src.indexOf("app.post('/v1/caregivers/invitations/accept'"));
    const accept = src.slice(src.indexOf("app.post('/v1/caregivers/invitations/accept'"), src.indexOf("app.post('/v1/caregivers/accept'"));
    // Actual self/missing recipient behavior is exercised against SQL/RLS in
    // invitation-review-enforcement; this check only locates the client contract.
    for (const route of [preview, accept]) expect(route).toContain('new AppError(ERROR_CODES.INVITATION_INVALID, 404');
  });

  it.each(['ios', 'web'])('preserves the token after a wrong-account rejection on %s until explicit acceptance', async (platform) => {
    let storedToken: string | null = 'synthetic-invitation-token';
    const clear = vi.fn(async () => { storedToken = null; });
    const refreshProfiles = vi.fn().mockResolvedValue(undefined);
    const h = createHarness(ACCEPT, join(ROOT, 'apps/mobile/src/hooks/useRequestScope.ts'), {}, {
      'expo-router': { useLocalSearchParams: () => ({}), router: { replace: vi.fn(), push: vi.fn() } },
      'react-native': { Platform: { OS: platform } },
      '@/components/PhoneVerification': { PhoneVerification: 'PhoneVerification' },
      '@/components/InvitationPermissions': { InvitationPermissions: 'InvitationPermissions' },
      '@/storage/pending-invite': {
        peekPendingInvite: async () => storedToken,
        stashPendingInvite: async () => undefined,
        clearPendingInvite: clear,
      },
    });
    Object.assign(h.app, { signedIn: true, profiles: [], refreshProfiles, setActiveProfile: vi.fn() });
    const preview = {
      id: 'invitation-a', patientName: 'Synthetic patient', role: 'caregiver',
      permissions: ['view_schedule'], expiresAt: '2099-01-01',
    };
    try {
      h.render(); await h.flush();
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]).toMatchObject({
        route: '/v1/caregivers/invitations/preview', payload: { token: storedToken },
      });
      h.requests[0].reject(new ApiError('invitation_invalid')); await h.flush();
      expect(h.text()).toContain(platform === 'web' ? 'accept.webIdentityHelp' : 'accept.invalidBody');
      expect(h.find('InvitationPermissions')).toBeNull();
      expect(h.find('Button', (p: any) => p.label === 'invite.accept')).toBeNull();
      expect(clear).not.toHaveBeenCalled();

      // Switching accounts must re-review the same stored capability, not accept it.
      h.app.user = { id: 'intended-recipient' }; h.render(); await h.flush();
      expect(h.requests).toHaveLength(2);
      expect(h.requests[1]).toMatchObject({
        route: '/v1/caregivers/invitations/preview', payload: { token: 'synthetic-invitation-token' },
      });
      h.requests[1].resolve(preview); await h.flush();
      expect(h.find('InvitationPermissions').invitation).toEqual(preview);
      expect(h.requests).toHaveLength(2);
      expect(clear).not.toHaveBeenCalled();

      h.find('Button', (p: any) => p.label === 'invite.accept').onPress(); await h.flush();
      expect(h.requests).toHaveLength(3);
      expect(h.requests[2]).toMatchObject({
        route: '/v1/caregivers/invitations/accept',
        payload: { relationshipId: preview.id, role: preview.role, permissions: preview.permissions },
      });
      expect(clear).not.toHaveBeenCalled();
      h.requests[2].resolve({ profileId: 'patient-a' }); await h.flush();
      expect(clear).toHaveBeenCalledOnce();
      expect(storedToken).toBeNull();
      expect(refreshProfiles).toHaveBeenCalledOnce();
    } finally { h.unmount(); }
  });
});
