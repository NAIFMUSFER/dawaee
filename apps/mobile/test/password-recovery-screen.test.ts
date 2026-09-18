import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { createHarness } = require('./profile-screen-harness.cjs');
const setups: any[] = [];
function screen() {
  const h = createHarness(resolve('apps/mobile/app/(auth)/forgot-password.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'));
  setups.push(h);
  const press = async (label: string) => { h.find('Button', (p: any) => p.label === label)?.onPress(); await h.flush(); };
  const field = async (value: string) => { h.find('Field', (p: any) => p.label === 'emailAccount.email').onChangeText(value); await h.flush(); };
  const ready = async () => { const r = h.requests[0]; r.completed = true; r.resolve({ provider: 'email', available: true }); await h.flush(); };
  return { h, press, field, ready };
}
afterEach(() => { for (const h of setups.splice(0)) h.unmount(); });
describe('email password recovery screen', () => {
  it('keeps recovery reachable from sign in', () => {
    const h = createHarness(resolve('apps/mobile/app/(auth)/sign-in.tsx'), undefined, {}, { '@/storage/pending-invite': { landingAfterAuth: async () => '/(tabs)/today' } });
    setups.push(h); h.find('Button', (p: any) => p.label === 'recovery.title').onPress();
    expect(h.routes).toEqual(['/(auth)/forgot-password']);
  });
  it('requires readiness and explicitly requests a normalized email without SMS', async () => {
    const s = screen(); expect(s.h.requests).toHaveLength(1); expect(s.h.find('Field')).toBeNull();
    await s.ready(); await s.field('  Patient@Example.com  '); await s.press('emailAccount.sendReset'); await s.press('emailAccount.sendReset');
    expect(s.h.requests).toHaveLength(2);
    expect(s.h.requests[1].payload).toEqual({ email: 'patient@example.com' });
    expect(s.h.requests[1].route).toBe('/v1/auth/password/recovery/request');
    expect(s.h.text()).not.toContain('emailAccount.requested');
    s.h.requests[1].resolve({ accepted: true }); await s.h.flush();
    expect(s.h.text()).toContain('emailAccount.requested'); expect(s.h.text()).toContain('recovery.cooldown');
  });
  it('fails closed for old SMS discovery and missing configuration', async () => {
    for (const provider of ['twilio', 'firebase', 'email']) {
      const s = screen(); s.h.requests[0].resolve({ provider, available: provider !== 'email' }); await s.h.flush();
      expect(s.h.text()).toContain('emailAccount.unavailable'); expect(s.h.find('Field')).toBeNull();
    }
  });
  it('does not report a sent email after failure or a malformed acknowledgement', async () => {
    const s = screen(); await s.ready(); await s.field('patient@example.com'); await s.press('emailAccount.sendReset');
    s.h.requests[1].resolve({ accepted: false }); await s.h.flush();
    expect(s.h.text()).toContain('emailAccount.unavailable'); expect(s.h.text()).not.toContain('emailAccount.requested');
    await s.press('emailAccount.sendReset'); expect(s.h.requests).toHaveLength(2);
  });
  it('ignores responses after unmount and never navigates with credentials', async () => {
    const s = screen(); await s.ready(); await s.field('patient@example.com'); await s.press('emailAccount.sendReset');
    s.h.unmount(); s.h.requests[1].resolve({ accepted: true }); await s.h.flush(); expect(s.h.routes).toEqual([]);
  });
});
