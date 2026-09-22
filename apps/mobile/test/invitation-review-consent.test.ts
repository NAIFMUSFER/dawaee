import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
const { createHarness, ApiError, NetworkError } = createRequire(import.meta.url)('./profile-screen-harness.cjs');
const preview = { id: 'invitation-a', patientName: 'Synthetic patient', role: 'nurse', permissions: ['view_schedule', 'confirm_dose'], expiresAt: '2099-01-01' };
function setup(platform = 'ios', signedIn = true) {
  const navigation = { replace: vi.fn(), push: vi.fn() };
  let token: string | null = 'synthetic-invitation-token';
  const clear = vi.fn(async () => { token = null; });
  const refreshProfiles = vi.fn().mockResolvedValue(undefined), setActiveProfile = vi.fn();
  const h = createHarness(resolve('apps/mobile/app/caregiver/accept.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), {}, {
    'expo-router': { useLocalSearchParams: () => ({}), router: navigation },
    'react-native': { Platform: { OS: platform } },
    '@/components/PhoneVerification': { PhoneVerification: 'PhoneVerification' },
    '@/components/InvitationPermissions': { InvitationPermissions: 'InvitationPermissions' },
    '@/storage/pending-invite': { peekPendingInvite: async () => token, stashPendingInvite: async () => undefined, clearPendingInvite: clear },
  });
  Object.assign(h.app, { signedIn, profiles: [], refreshProfiles, setActiveProfile }); h.render();
  return { h, clear, refreshProfiles, setActiveProfile, navigation };
}
describe('explicit caregiver invitation consent', () => {
  it('offers mailbox account creation before review without consuming the invitation', async () => {
    const { h, navigation, clear } = setup('web', false);
    try {
      await h.flush();
      expect(h.text()).toContain('accept.webSignInBody');
      h.find('Button', (p: any) => p.label === 'auth.signUp').onPress();
      expect(navigation.push).toHaveBeenCalledWith('/(auth)/sign-up');
      expect(h.requests).toHaveLength(0); expect(clear).not.toHaveBeenCalled();
    } finally { h.unmount(); }
  });
  it('explains how to replace an old phone invite on web without granting or discarding it', async () => {
    const { h, clear } = setup('web');
    try {
      await h.flush(); h.requests[0].reject(new ApiError('invitation_invalid')); await h.flush();
      expect(h.text()).toContain('accept.webIdentityHelp');
      expect(h.find('InvitationPermissions')).toBeNull();
      expect(h.requests).toHaveLength(1); expect(clear).not.toHaveBeenCalled();
    } finally { h.unmount(); }
  });

  it('only previews on sign-in and submits precisely the displayed grant after a single deliberate click', async () => {
    const { h } = setup();
    try {
      await h.flush();
      expect(h.requests.map((r: any) => r.route)).toEqual(['/v1/caregivers/invitations/preview']);
      h.requests[0].resolve(preview); await h.flush();
      expect(h.find('InvitationPermissions').invitation).toEqual(preview);
      expect(h.requests).toHaveLength(1);
      const button = h.find('Button', (p: any) => p.label === 'invite.accept');
      button.onPress(); button.onPress(); await h.flush();
      expect(h.requests).toHaveLength(2);
      expect(h.requests[1]).toMatchObject({ route: '/v1/caregivers/invitations/accept', payload: { relationshipId: preview.id, role: preview.role, permissions: preview.permissions } });
    } finally { h.unmount(); }
  });
  it('does not accept after verification and asks again after permissions change', async () => {
    const { h } = setup();
    try {
      await h.flush(); h.requests[0].reject(new ApiError('phone_verification_required')); await h.flush();
      h.find('PhoneVerification').onVerified(); await h.flush();
      expect(h.requests[1].route).toBe('/v1/caregivers/invitations/preview');
      h.requests[1].resolve(preview); await h.flush();
      h.find('Button', (p: any) => p.label === 'invite.accept').onPress(); await h.flush();
      h.requests[2].reject(new ApiError('invitation_changed')); await h.flush();
      expect(h.requests[3].route).toBe('/v1/caregivers/invitations/preview');
      h.requests[3].resolve({ ...preview, permissions: ['view_schedule'] }); await h.flush();
      expect(h.text()).toContain('accept.changed');
      expect(h.find('InvitationPermissions').invitation.permissions).toEqual(['view_schedule']);
      expect(h.requests.filter((r: any) => r.route.endsWith('/accept'))).toHaveLength(1);
    } finally { h.unmount(); }
  });
  it('can retry an ambiguous acceptance explicitly and never reaccepts after a profile reload failure', async () => {
    const { h, refreshProfiles } = setup(); refreshProfiles.mockRejectedValueOnce(new Error('offline'));
    try {
      await h.flush(); h.requests[0].resolve(preview); await h.flush();
      h.find('Button', (p: any) => p.label === 'invite.accept').onPress(); await h.flush();
      h.requests[1].reject(new NetworkError()); await h.flush();
      h.find('Button', (p: any) => p.label === 'invite.accept').onPress(); await h.flush();
      expect(h.requests[2].payload).toEqual(h.requests[1].payload);
      h.requests[2].resolve({ profileId: 'patient-a' }); await h.flush();
      expect(h.text()).toContain('accept.refreshRequired');
      h.find('Button', (p: any) => p.label === 'common.retry').onPress(); await h.flush();
      expect(h.requests).toHaveLength(3);
      expect(refreshProfiles).toHaveBeenCalledTimes(2);
    } finally { h.unmount(); }
  });
  it('discards an old account preview on the very first frame and ignores its late response', async () => {
    const { h } = setup();
    try {
      await h.flush(); const old = h.requests[0];
      h.app.user = { id: 'other-user' }; h.render(); await h.flush();
      old.resolve(preview); await h.flush();
      expect(h.find('InvitationPermissions')).toBeNull();
      expect(h.text()).not.toContain('Synthetic patient');
    } finally { h.unmount(); }
  });
  it('Not now forgets the stored capability without accepting or revoking the patient invitation', async () => {
    const { h, clear } = setup();
    try {
      await h.flush(); h.requests[0].resolve(preview); await h.flush();
      h.find('Button', (p: any) => p.label === 'accept.notNow').onPress(); await h.flush();
      expect(clear).toHaveBeenCalledOnce(); expect(h.requests).toHaveLength(1);
    } finally { h.unmount(); }
  });
});
