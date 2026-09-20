import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
const { createHarness } = createRequire(import.meta.url)('./profile-screen-harness.cjs');

describe('verified email invitation discovery', () => {
  it('keeps the accepted result when profile reload fails, then opens the patient without accepting twice', async () => {
    const refreshProfiles = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const setActiveProfile = vi.fn();
    const h = createHarness(resolve('apps/mobile/src/components/IncomingInvitations.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), {}, {
      __exportName: 'IncomingInvitations',
      './InvitationPermissions': { InvitationPermissions: 'InvitationPermissions' },
      './ui': new Proxy({}, { get: (_, key) => String(key) }),
      '@/state/app-store': { useApp: () => ({ user: { id: 'synthetic-recipient' }, refreshProfiles, setActiveProfile }) },
    });
    try {
      h.requests[0].resolve({ invitations: [{ id: 'invite-a', patientName: 'Synthetic patient', role: 'caregiver', permissions: ['view_schedule'], expiresAt: '2099-01-01' }] });
      await h.flush();
      h.find('Button', (p: any) => p.label === 'invite.accept').onPress(); await h.flush();
      h.requests[1].resolve({ profileId: 'patient-a' }); await h.flush();
      expect(h.text()).toContain('accept.refreshRequired');
      expect(setActiveProfile).not.toHaveBeenCalled();
      h.find('Button', (p: any) => p.label === 'common.continue').onPress(); await h.flush();
      expect(setActiveProfile).toHaveBeenCalledWith('patient-a');
      expect(h.routes).toEqual(['/caregiver/dashboard']);
      expect(h.requests.filter((r: any) => r.method === 'POST')).toHaveLength(1);
    } finally { h.unmount(); }
  });
});
