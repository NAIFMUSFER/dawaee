import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
const { createHarness, NetworkError } = createRequire(import.meta.url)('./profile-screen-harness.cjs');
const hook = resolve('apps/mobile/src/hooks/useRequestScope.ts');
function privacy() {
  const signOut = vi.fn().mockResolvedValue(undefined);
  const h = createHarness(resolve('apps/mobile/app/settings/privacy.tsx'), hook, { role: 'owner', isSelf: true }, {
    '@dawaee/shared': { MESSAGES: { en: {} } },
  });
  h.app.signOut = signOut; h.render();
  return { h, signOut };
}
describe('account deletion receipt and recovery controls', () => {
  it('requires two deliberate steps, ignores duplicate taps and carries the server deadline across immediate sign-out', async () => {
    const {h,signOut} = privacy();
    try {
      h.requests[0].resolve({ consents: [] }); await h.flush();
      h.find('Button', (p:any)=>p.label==='privacy.deleteStep1').onPress(); await h.flush();
      expect(h.requests).toHaveLength(1);
      const button = h.find('Button', (p:any)=>p.label==='privacy.deleteStep2');
      button.onPress(); button.onPress(); await h.flush();
      expect(h.requests).toHaveLength(2); expect(signOut).not.toHaveBeenCalled();
      const date='2099-01-15T12:00:00.000Z'; h.requests[1].resolve({ scheduledFor: date }); await h.flush();
      expect(h.deletionReceipt).toBe(date); expect(signOut).toHaveBeenCalledOnce();
    } finally { h.unmount(); }
  });
  it('does not claim successful deletion on a lost response or publish an old account result', async () => {
    for (const switched of [false,true]) {
      const {h,signOut} = privacy();
      try {
        h.requests[0].resolve({consents:[]}); await h.flush();
        h.find('Button',(p:any)=>p.label==='privacy.deleteStep1').onPress(); await h.flush();
        h.find('Button',(p:any)=>p.label==='privacy.deleteStep2').onPress(); await h.flush();
        if(switched) { h.app.user={id:'new-account'}; h.render(); h.requests[1].resolve({scheduledFor:'2099-01-15T12:00:00Z'}); }
        else h.requests[1].reject(new NetworkError());
        await h.flush(); expect(signOut).not.toHaveBeenCalled(); expect(h.deletionReceipt).toBeUndefined();
        if(!switched) expect(h.text()).toContain('privacy.deleteUncertain');
      } finally { h.unmount(); }
    }
  });
  it('cancels only on the explicit recovery button and retries profile loading without sending cancellation twice', async () => {
    const refreshProfiles=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const h=createHarness(resolve('apps/mobile/src/components/AccountDeletionNotice.tsx'),hook,{}, {
      __exportName:'PendingDeletionScreen',
      '@/privacy/deletion-receipt': {}, './ui':new Proxy({}, {get:(_,key)=>String(key)}),
    });
    try {
      h.app.user={id:'owner',deletionScheduledFor:'2099-01-15T12:00:00Z'};
      h.app.refreshProfiles=refreshProfiles; h.app.signOut=vi.fn(); h.render(); await h.flush();
      expect(h.requests).toHaveLength(0);
      h.find('Button',(p:any)=>p.label==='privacy.deleteCancel').onPress(); await h.flush();
      expect(h.requests[0]).toMatchObject({route:'/v1/me/deletion-cancel',payload:{confirm:true}});
      h.requests[0].resolve({cancelled:true}); await h.flush();
      expect(h.text()).toContain('privacy.deleteCancelled');
      h.find('Button',(p:any)=>p.label==='common.retry').onPress(); await h.flush();
      expect(h.requests).toHaveLength(1); expect(refreshProfiles).toHaveBeenCalledTimes(2);
    } finally {h.unmount();}
  });
});
